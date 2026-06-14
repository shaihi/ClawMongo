import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import {
  closeWaSocket,
  waitForWhatsAppLoginResult,
  WhatsAppConnectionController,
} from "./connection-controller.js";
import { enqueueCredsSave, writeCredsJsonAtomically } from "./creds-persistence.js";
import type { WhatsAppSendKind, WhatsAppSendResult } from "./inbound/send-result.js";
import { createWaSocket, readWebAuthExistsForDecision, waitForWaConnection } from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
    readWebAuthExistsForDecision: vi.fn(async () => ({ outcome: "stable" as const, exists: true })),
  };
});

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);

function acceptedSendResult(kind: WhatsAppSendKind, id: string): WhatsAppSendResult {
  return {
    kind,
    messageId: id,
    keys: [{ id }],
    providerAccepted: true,
  };
}

function createListenerStub(messageId = "ok") {
  return {
    sendMessage: vi.fn(async () => acceptedSendResult("text", messageId)),
    sendPoll: vi.fn(async () => acceptedSendResult("poll", messageId)),
    sendReaction: vi.fn(async () => acceptedSendResult("reaction", messageId)),
    sendComposingTo: vi.fn(async () => {}),
  };
}

function createSocketWithTransportEmitter() {
  const ws = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  ws.close = vi.fn();
  return {
    end: vi.fn(),
    ws,
  };
}

describe("WhatsAppConnectionController", () => {
  let controller: WhatsAppConnectionController;

  beforeEach(() => {
    vi.clearAllMocks();
    readWebAuthExistsForDecisionMock
      .mockReset()
      .mockResolvedValue({ outcome: "stable", exists: true });
    controller = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });
  });

  afterEach(async () => {
    await controller.shutdown();
  });

  it("closes the socket when open fails before listener creation", async () => {
    const sock = {
      end: vi.fn(),
      ws: {
        close: vi.fn(),
      },
    };
    const createListener = vi.fn();

    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockRejectedValueOnce(new Error("handshake failed"));

    await expect(
      controller.openConnection({
        connectionId: "conn-1",
        createListener,
      }),
    ).rejects.toThrow("handshake failed");

    expect(createListener).not.toHaveBeenCalled();
    expect(sock.end).toHaveBeenCalledOnce();
    const closeError = sock.end.mock.calls.at(0)?.[0] as Error | undefined;
    expect(closeError).toBeInstanceOf(Error);
    expect(closeError?.message).toBe("OpenClaw WhatsApp socket close");
    expect(sock.ws.close).not.toHaveBeenCalled();
    expect(controller.socketRef.current).toBeNull();
    expect(controller.getActiveListener()).toBeNull();
  });

  it("falls back to raw websocket close when Baileys end is unavailable", () => {
    const sock = { ws: { close: vi.fn() } };

    closeWaSocket(sock);

    expect(sock.ws.close).toHaveBeenCalledOnce();
  });

  it("lets createWaSocket own the auth barrier before opening a socket", async () => {
    const callOrder: string[] = [];
    createWaSocketMock.mockImplementationOnce(async () => {
      callOrder.push("create");
      return { ws: { close: vi.fn() } } as never;
    });
    waitForWaConnectionMock.mockImplementationOnce(async () => {
      callOrder.push("wait-for-connection");
    });

    await controller.openConnection({
      connectionId: "conn-flush-first",
      createListener: async () => createListenerStub() as never,
    });

    expect(callOrder).toEqual(["create", "wait-for-connection"]);
  });

  it("returns a retryable failure when the socket opens before auth persistence settles", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "unstable" });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);

    const result = await waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toMatch(/retry/i);
      expect((result.error as { code?: string })?.code).toBe("whatsapp-auth-unstable");
    }
  });

  it("returns a retryable failure when auth is not linked on disk after the socket opens", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: false });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);

    const result = await waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toMatch(/retry/i);
      expect((result.error as { code?: string })?.code).toBe("whatsapp-auth-unstable");
    }
  });

  it("returns connected only after auth is confirmed durable on disk", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: true });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);
    const sock = createSocketWithTransportEmitter();

    const result = await waitForWhatsAppLoginResult({
      sock: sock as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result).toEqual({ outcome: "connected", restarted: false, sock });
    expect(readWebAuthExistsForDecisionMock).toHaveBeenCalledWith("/tmp/wa-auth");
  });

  it("waits for queued creds persistence so linked auth survives an auth-dir reuse", async () => {
    const actualSession = await vi.importActual<typeof import("./session.js")>("./session.js");
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-auth-durability-"));
    try {
      readWebAuthExistsForDecisionMock.mockImplementation(
        actualSession.readWebAuthExistsForDecision,
      );
      let credsSaved = false;
      enqueueCredsSave(
        authDir,
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          await writeCredsJsonAtomically(authDir, { me: { id: "123@s.whatsapp.net" } });
          credsSaved = true;
        },
        () => {},
      );

      const result = await waitForWhatsAppLoginResult({
        sock: createSocketWithTransportEmitter() as never,
        authDir,
        isLegacyAuthDir: false,
        verbose: false,
        runtime: { log: vi.fn() } as never,
        waitForConnection: vi.fn().mockResolvedValueOnce(undefined) as never,
      });

      expect(credsSaved).toBe(true);
      expect(result.outcome).toBe("connected");
      // A fresh read of the same auth dir is what a restarted/rebuilt container does.
      await expect(actualSession.webAuthExists(authDir)).resolves.toBe(true);
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });

  it("keeps the previous registered controller until a replacement listener is ready", async () => {
    const liveController = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });
    const liveListener = createListenerStub("live");
    createWaSocketMock.mockResolvedValueOnce({ ws: { close: vi.fn() } } as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await liveController.openConnection({
      connectionId: "live-conn",
      createListener: async () => liveListener,
    });

    expect(getRegisteredWhatsAppConnectionController("work")).toBe(liveController);

    const replacement = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth-2",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      createWaSocketMock.mockResolvedValueOnce({ ws: { close: vi.fn() } } as never);
      waitForWaConnectionMock.mockRejectedValueOnce(new Error("replacement failed"));

      await expect(
        replacement.openConnection({
          connectionId: "replacement-conn",
          createListener: async () => liveListener,
        }),
      ).rejects.toThrow("replacement failed");

      expect(getRegisteredWhatsAppConnectionController("work")).toBe(liveController);
    } finally {
      await replacement.shutdown();
      await liveController.shutdown();
    }
  });

  it("tracks real websocket frame activity in the connection snapshot", async () => {
    vi.useFakeTimers();
    const controller = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: true,
      heartbeatSeconds: 1,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      const sock = createSocketWithTransportEmitter();
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const snapshots: Array<{ lastTransportActivityAt: number }> = [];
      await controller.openConnection({
        connectionId: "conn-frame-activity",
        createListener: async () => createListenerStub() as never,
        onHeartbeat: (snapshot) => snapshots.push(snapshot),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const firstSnapshot = snapshots.at(-1);
      expect(firstSnapshot?.lastTransportActivityAt).toBeTypeOf("number");

      const firstTransportAt = firstSnapshot?.lastTransportActivityAt ?? 0;
      await vi.advanceTimersByTimeAsync(250);
      sock.ws.emit("frame");
      await vi.advanceTimersByTimeAsync(1_000);

      const lastSnapshot = snapshots.at(-1);
      expect(lastSnapshot?.lastTransportActivityAt).toBeGreaterThan(firstTransportAt);
    } finally {
      await controller.shutdown();
      vi.useRealTimers();
    }
  });

  it("forces reconnect on transport stall before the long app-silence window", async () => {
    vi.useFakeTimers();
    const controller = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: true,
      heartbeatSeconds: 1,
      transportTimeoutMs: 30,
      messageTimeoutMs: 3_000,
      watchdogCheckMs: 5,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      const sock = createSocketWithTransportEmitter();
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const timeouts: string[] = [];
      await controller.openConnection({
        connectionId: "conn-transport-timeout",
        createListener: async () => createListenerStub() as never,
        onWatchdogTimeout: () => timeouts.push("timeout"),
      });

      await vi.advanceTimersByTimeAsync(40);

      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await controller.shutdown();
      vi.useRealTimers();
    }
  });
});
