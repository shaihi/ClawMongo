import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterKnownTopics,
  InterviewSessionStore,
  isGrillMeTrigger,
  isStopTrigger,
  maybeHandleGuideInterviewMessage,
  pickNextQuestion,
  QUESTION_BANK,
  type GuideInterviewMsg,
  type KeepFactResult,
  type TourbotCliBridge,
} from "./guide-interview.js";

const GUIDE_E164 = "+255787096872";

function createMsg(overrides: Partial<GuideInterviewMsg> = {}): GuideInterviewMsg & {
  reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  return {
    chatType: "direct",
    from: GUIDE_E164,
    conversationId: GUIDE_E164,
    body: "",
    senderE164: GUIDE_E164,
    reply,
    ...overrides,
  };
}

function createBridge(overrides: Partial<TourbotCliBridge> = {}): TourbotCliBridge {
  let counter = 0;
  return {
    keep: vi.fn(
      async (text: string): Promise<KeepFactResult> => ({
        proposed_fact: text,
        category: "general",
        status: "candidate",
        knowledge_id: `id-${++counter}`,
      }),
    ),
    topicsKnown: vi.fn(async () => ({ categories: {}, topicKeys: [] })),
    ...overrides,
  };
}

describe("trigger detection", () => {
  it("recognizes 'grill me' with any casing/whitespace", () => {
    expect(isGrillMeTrigger("grill me")).toBe(true);
    expect(isGrillMeTrigger("  Grill Me  ")).toBe(true);
    expect(isGrillMeTrigger("GRILL ME about pricing")).toBe(true);
    expect(isGrillMeTrigger("please grill me")).toBe(false);
    expect(isGrillMeTrigger("hello")).toBe(false);
  });

  it("recognizes stop words", () => {
    expect(isStopTrigger("stop")).toBe(true);
    expect(isStopTrigger("Done")).toBe(true);
    expect(isStopTrigger(" that's all ")).toBe(true);
    expect(isStopTrigger("stop asking")).toBe(false);
  });
});

describe("filterKnownTopics / pickNextQuestion", () => {
  it("drops bank topics whose slug is covered by a known topic_key", () => {
    const filtered = filterKnownTopics(QUESTION_BANK, ["pricing_park_fees", "safety_wildlife"]);
    expect(filtered.some((q) => q.topic === "pricing")).toBe(false);
    expect(filtered.some((q) => q.topic === "safety")).toBe(false);
    expect(filtered.some((q) => q.topic === "destinations")).toBe(true);
  });

  it("picks the first question not yet asked this session", () => {
    const bank = [...QUESTION_BANK];
    const first = pickNextQuestion({ bank, askedTopics: new Set() });
    expect(first?.topic).toBe(bank[0].topic);
    const second = pickNextQuestion({ bank, askedTopics: new Set([bank[0].topic]) });
    expect(second?.topic).toBe(bank[1].topic);
  });

  it("returns null once every bank topic has been asked", () => {
    const bank = QUESTION_BANK.slice(0, 2);
    const askedTopics = new Set(bank.map((q) => q.topic));
    expect(pickNextQuestion({ bank, askedTopics })).toBeNull();
  });
});

describe("maybeHandleGuideInterviewMessage", () => {
  let store: InterviewSessionStore;

  beforeEach(() => {
    store = new InterviewSessionStore();
  });

  afterEach(() => {
    delete process.env.TOURBOT_GUIDE_E164;
  });

  it("ignores group messages entirely", async () => {
    const msg = createMsg({ chatType: "group" });
    const bridge = createBridge();
    const handled = await maybeHandleGuideInterviewMessage({ msg, cliBridge: bridge, store });
    expect(handled).toBe(false);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("ignores DMs from anyone other than the configured guide", async () => {
    const msg = createMsg({ senderE164: "+15551234567", body: "grill me" });
    const bridge = createBridge();
    const handled = await maybeHandleGuideInterviewMessage({ msg, cliBridge: bridge, store });
    expect(handled).toBe(false);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("ignores guide DMs that are not the trigger when no session is active", async () => {
    const msg = createMsg({ body: "hey, quick question" });
    const bridge = createBridge();
    const handled = await maybeHandleGuideInterviewMessage({ msg, cliBridge: bridge, store });
    expect(handled).toBe(false);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("starts an interview session on 'grill me' and asks the first question", async () => {
    const msg = createMsg({ body: "grill me" });
    const bridge = createBridge();
    const handled = await maybeHandleGuideInterviewMessage({ msg, cliBridge: bridge, store });
    expect(handled).toBe(true);
    expect(store.isActive(GUIDE_E164)).toBe(true);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply.mock.calls[0][0]).toContain(QUESTION_BANK[0].question);
    expect(bridge.topicsKnown).toHaveBeenCalledTimes(1);
  });

  it("skips known-topic questions when starting the interview", async () => {
    const msg = createMsg({ body: "grill me" });
    const bridge = createBridge({
      topicsKnown: vi.fn(async () => ({
        categories: {},
        topicKeys: [QUESTION_BANK[0].topic],
      })),
    });
    await maybeHandleGuideInterviewMessage({ msg, cliBridge: bridge, store });
    expect(msg.reply.mock.calls[0][0]).not.toContain(QUESTION_BANK[0].question);
    expect(msg.reply.mock.calls[0][0]).toContain(QUESTION_BANK[1].question);
  });

  it("persists an answer via the cli bridge and asks the next question", async () => {
    const startMsg = createMsg({ body: "grill me" });
    const bridge = createBridge();
    await maybeHandleGuideInterviewMessage({ msg: startMsg, cliBridge: bridge, store });

    const answerMsg = createMsg({ body: "We always recommend the hidden waterfall detour." });
    const handled = await maybeHandleGuideInterviewMessage({
      msg: answerMsg,
      cliBridge: bridge,
      store,
    });

    expect(handled).toBe(true);
    expect(bridge.keep).toHaveBeenCalledWith(
      "We always recommend the hidden waterfall detour.",
    );
    expect(answerMsg.reply.mock.calls[0][0]).toContain(QUESTION_BANK[1].question);
    expect(store.get(GUIDE_E164)?.answeredCount).toBe(1);
  });

  it("flags needs_review facts distinctly in the ack", async () => {
    const startMsg = createMsg({ body: "grill me" });
    const bridge = createBridge({
      keep: vi.fn(async () => ({
        proposed_fact: "fact",
        category: "commercial_contractual",
        status: "needs_review",
        knowledge_id: "id-1",
      })),
    });
    await maybeHandleGuideInterviewMessage({ msg: startMsg, cliBridge: bridge, store });

    const answerMsg = createMsg({ body: "It costs $50 per person." });
    await maybeHandleGuideInterviewMessage({ msg: answerMsg, cliBridge: bridge, store });
    expect(answerMsg.reply.mock.calls[0][0]).toContain("flagged for review");
  });

  it("ends the session on stop and reports how many facts were logged", async () => {
    const startMsg = createMsg({ body: "grill me" });
    const bridge = createBridge();
    await maybeHandleGuideInterviewMessage({ msg: startMsg, cliBridge: bridge, store });

    const answerMsg = createMsg({ body: "Answer one." });
    await maybeHandleGuideInterviewMessage({ msg: answerMsg, cliBridge: bridge, store });

    const stopMsg = createMsg({ body: "stop" });
    const handled = await maybeHandleGuideInterviewMessage({ msg: stopMsg, cliBridge: bridge, store });

    expect(handled).toBe(true);
    expect(store.isActive(GUIDE_E164)).toBe(false);
    expect(stopMsg.reply.mock.calls[0][0]).toContain("logged 1 new fact");
  });

  it("ends the session automatically once every question has been asked", async () => {
    const shortBank = QUESTION_BANK.slice(0, 1);
    const bridge = createBridge({
      topicsKnown: vi.fn(async () => ({
        categories: {},
        topicKeys: QUESTION_BANK.slice(1).map((q) => q.topic),
      })),
    });
    const startMsg = createMsg({ body: "grill me" });
    await maybeHandleGuideInterviewMessage({ msg: startMsg, cliBridge: bridge, store });
    expect(store.get(GUIDE_E164)?.bank).toEqual(shortBank);

    const answerMsg = createMsg({ body: "Final answer." });
    await maybeHandleGuideInterviewMessage({ msg: answerMsg, cliBridge: bridge, store });

    expect(store.isActive(GUIDE_E164)).toBe(false);
    expect(answerMsg.reply.mock.calls[0][0]).toContain("That's everything on my list");
  });

  it("does not call keep() for an empty answer and re-prompts instead", async () => {
    const startMsg = createMsg({ body: "grill me" });
    const bridge = createBridge();
    await maybeHandleGuideInterviewMessage({ msg: startMsg, cliBridge: bridge, store });

    const emptyMsg = createMsg({ body: "   " });
    await maybeHandleGuideInterviewMessage({ msg: emptyMsg, cliBridge: bridge, store });

    expect(bridge.keep).not.toHaveBeenCalled();
    expect(store.isActive(GUIDE_E164)).toBe(true);
  });

  it("keeps the session open and reports an error if the keep() bridge call fails", async () => {
    const startMsg = createMsg({ body: "grill me" });
    const bridge = createBridge({
      keep: vi.fn(async () => {
        throw new Error("mongo unreachable");
      }),
    });
    await maybeHandleGuideInterviewMessage({ msg: startMsg, cliBridge: bridge, store });

    const answerMsg = createMsg({ body: "An answer that fails to persist." });
    const handled = await maybeHandleGuideInterviewMessage({
      msg: answerMsg,
      cliBridge: bridge,
      store,
    });

    expect(handled).toBe(true);
    expect(store.isActive(GUIDE_E164)).toBe(true);
    expect(answerMsg.reply.mock.calls[0][0]).toContain("mongo unreachable");
  });

  it("honors TOURBOT_GUIDE_E164 override for identifying the guide", async () => {
    process.env.TOURBOT_GUIDE_E164 = "+15551234567";
    const msg = createMsg({ senderE164: "+15551234567", body: "grill me" });
    const bridge = createBridge();
    const handled = await maybeHandleGuideInterviewMessage({ msg, cliBridge: bridge, store });
    expect(handled).toBe(true);
  });
});
