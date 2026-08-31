// Private DM fact-learning ("grill me" mode).
//
// When the real human guide (Thom) messages the bot 1:1 and sends exactly
// (or starting with) "grill me", the bot switches into an active interview:
// it asks targeted questions to elicit new tour-guide knowledge, and each
// answer is persisted through server/'s existing keepCommand pipeline
// (sanitize -> classify -> privacy-gate -> store as candidate/needs_review)
// so it lands in the same `tourbot review-list` / `tourbot approve` queue
// used throughout this project — via the `tourbot keep` CLI bridge, since
// ClawMongo (the live WhatsApp gateway) and server/ (the TourBot knowledge
// pipeline) are separate deployable layers with no shared runtime import
// boundary. See createTourbotCliBridge().
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getSenderIdentity } from "../../identity.js";
import { normalizeE164 } from "../../text-runtime.js";
import { resolveGuideE164 } from "./guide-activation-shared.js";

const execFileAsync = promisify(execFile);

// -----------------------------------------------------------------------
// Pure trigger / text helpers (no IO — easy to unit test)
// -----------------------------------------------------------------------

export function normalizeTrigger(body: string): string {
  return (body ?? "").trim().toLowerCase();
}

export function isGrillMeTrigger(body: string): boolean {
  return normalizeTrigger(body).startsWith("grill me");
}

const STOP_WORDS = new Set(["stop", "done", "that's all", "thats all", "end", "quit"]);

export function isStopTrigger(body: string): boolean {
  return STOP_WORDS.has(normalizeTrigger(body));
}

// -----------------------------------------------------------------------
// Question bank
// -----------------------------------------------------------------------

export interface InterviewQuestion {
  topic: string;
  question: string;
}

export const QUESTION_BANK: readonly InterviewQuestion[] = [
  {
    topic: "destinations",
    question:
      "What are 2-3 lesser-known destinations or stops you love recommending that aren't on the standard itinerary?",
  },
  {
    topic: "logistics",
    question:
      "What's a logistics detail clients often get wrong (pickup times, what to pack, permits) that you wish they knew upfront?",
  },
  {
    topic: "pricing",
    question:
      "Are there any prices, fees, or costs (park fees, tips, optional extras) that clients commonly ask about and are worth having on file?",
  },
  {
    topic: "policies",
    question: "What's your cancellation or rescheduling policy, in your own words?",
  },
  {
    topic: "safety",
    question:
      "Any safety guidance you always give clients (wildlife distance, health precautions, road conditions)?",
  },
  {
    topic: "seasonal",
    question:
      "How does the best time to visit change by season, and what should clients expect weather-wise?",
  },
  {
    topic: "group_logistics",
    question:
      "How do you usually handle group sizes, vehicle capacity, or family-friendly adjustments?",
  },
  {
    topic: "food_accommodation",
    question: "Any food, dietary, or accommodation details clients commonly ask about?",
  },
];

/** Drops question-bank topics that already look well covered by approved
 * knowledge (topic_key substring match against the guide's own topic slug). */
export function filterKnownTopics(
  bank: readonly InterviewQuestion[],
  knownTopicKeys: readonly string[],
): InterviewQuestion[] {
  const known = knownTopicKeys.map((key) => key.toLowerCase());
  return bank.filter((q) => !known.some((key) => key.includes(q.topic)));
}

export function pickNextQuestion(params: {
  bank: readonly InterviewQuestion[];
  askedTopics: ReadonlySet<string>;
}): InterviewQuestion | null {
  return params.bank.find((q) => !params.askedTopics.has(q.topic)) ?? null;
}

// -----------------------------------------------------------------------
// Session state (in-memory, per gateway process — mirrors the existing
// echo-detection / last-route Map-based session tracking used elsewhere in
// this monitor).
// -----------------------------------------------------------------------

export interface InterviewSession {
  active: boolean;
  askedTopics: Set<string>;
  bank: InterviewQuestion[];
  answeredCount: number;
  startedAt: number;
}

export class InterviewSessionStore {
  private readonly sessions = new Map<string, InterviewSession>();

  get(conversationId: string): InterviewSession | undefined {
    return this.sessions.get(conversationId);
  }

  isActive(conversationId: string): boolean {
    return this.sessions.get(conversationId)?.active === true;
  }

  start(conversationId: string, bank: InterviewQuestion[]): InterviewSession {
    const session: InterviewSession = {
      active: true,
      askedTopics: new Set(),
      bank,
      answeredCount: 0,
      startedAt: Date.now(),
    };
    this.sessions.set(conversationId, session);
    return session;
  }

  end(conversationId: string): void {
    this.sessions.delete(conversationId);
  }
}

/** Module-level default store shared across inbound turns for the life of
 * the gateway process. Tests should construct their own InterviewSessionStore
 * instead of relying on this singleton. */
export const guideInterviewSessions = new InterviewSessionStore();

// -----------------------------------------------------------------------
// tourbot CLI bridge
// -----------------------------------------------------------------------

export interface KeepFactResult {
  proposed_fact: string;
  category: string;
  status: "candidate" | "needs_review";
  knowledge_id: string;
}

export interface KnownTopics {
  categories: Record<string, number>;
  topicKeys: string[];
}

export interface TourbotCliBridge {
  keep(text: string): Promise<KeepFactResult>;
  topicsKnown(): Promise<KnownTopics>;
}

/** Repo root two levels above extensions/whatsapp/src/auto-reply/monitor
 * (…/monitor -> auto-reply -> src -> whatsapp -> extensions -> ClawMongo ->
 * repo root). Overridable via TOURBOT_REPO_ROOT for tests/alternate layouts. */
function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../../");
}

export function createTourbotCliBridge(
  params: { repoRoot?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): TourbotCliBridge {
  const repoRoot = params.repoRoot ?? process.env.TOURBOT_REPO_ROOT ?? defaultRepoRoot();
  const cliPath = path.join(repoRoot, "server", "src", "cli.ts");
  const timeout = params.timeoutMs ?? 20_000;

  const run = async (args: string[]): Promise<unknown> => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...args],
      { cwd: repoRoot, env: params.env ?? process.env, timeout },
    );
    return JSON.parse(stdout);
  };

  return {
    keep: async (text: string) => (await run(["keep", "--text", text])) as KeepFactResult,
    topicsKnown: async () => {
      try {
        return (await run(["topics-known"])) as KnownTopics;
      } catch {
        // Best-effort: an unreachable/unconfigured server layer should not
        // block the interview — fall back to the full question bank.
        return { categories: {}, topicKeys: [] };
      }
    },
  };
}

// -----------------------------------------------------------------------
// Turn handler
// -----------------------------------------------------------------------

export interface GuideInterviewMsg {
  chatType: "direct" | "group";
  from: string;
  conversationId?: string;
  body: string;
  sender?: unknown;
  senderJid?: string;
  senderE164?: string;
  reply: (text: string) => Promise<unknown>;
}

export interface MaybeHandleGuideInterviewParams {
  msg: GuideInterviewMsg;
  cliBridge: TourbotCliBridge;
  store?: InterviewSessionStore;
  guideE164?: string;
}

const INTRO =
  "Let's fill some gaps in the guide knowledge base! I'll ask a few quick questions — answer in your own words, or say \"stop\" anytime to end.";
const WRAP_UP_NO_MORE_QUESTIONS =
  "That's everything on my list for now — thanks Thom! Say \"grill me\" again anytime to keep going.";
const WRAP_UP_STOPPED = (count: number) =>
  count > 0
    ? `Got it — logged ${count} new fact${count === 1 ? "" : "s"} for review. Say "grill me" anytime to pick this up again.`
    : `No problem — nothing was logged this round. Say "grill me" anytime to pick this up again.`;

/**
 * Returns true when this inbound DM turn was fully handled by the guide
 * interview flow — callers must skip the normal agent turn in that case.
 */
export async function maybeHandleGuideInterviewMessage(
  params: MaybeHandleGuideInterviewParams,
): Promise<boolean> {
  const { msg } = params;
  if (msg.chatType === "group") {
    return false;
  }

  const guideE164 = normalizeE164(params.guideE164 ?? resolveGuideE164());
  const senderE164 = normalizeE164(getSenderIdentity(msg as never).e164 ?? undefined);
  if (!guideE164 || !senderE164 || senderE164 !== guideE164) {
    return false;
  }

  const store = params.store ?? guideInterviewSessions;
  const conversationId = msg.conversationId ?? msg.from;
  const body = msg.body ?? "";

  if (!store.isActive(conversationId)) {
    if (!isGrillMeTrigger(body)) {
      return false;
    }
    const known = await params.cliBridge.topicsKnown();
    const bank = filterKnownTopics(QUESTION_BANK, known.topicKeys);
    const effectiveBank = bank.length > 0 ? bank : [...QUESTION_BANK];
    const session = store.start(conversationId, effectiveBank);
    const first = pickNextQuestion({ bank: session.bank, askedTopics: session.askedTopics });
    if (!first) {
      store.end(conversationId);
      await msg.reply(WRAP_UP_NO_MORE_QUESTIONS);
      return true;
    }
    session.askedTopics.add(first.topic);
    await msg.reply(`${INTRO}\n\n${first.question}`);
    return true;
  }

  const session = store.get(conversationId);
  if (!session) {
    return false;
  }

  if (isStopTrigger(body)) {
    store.end(conversationId);
    await msg.reply(WRAP_UP_STOPPED(session.answeredCount));
    return true;
  }

  const answer = body.trim();
  if (!answer) {
    await msg.reply("Sorry, I didn't catch that — could you say it again?");
    return true;
  }

  let kept: KeepFactResult | undefined;
  try {
    kept = await params.cliBridge.keep(answer);
    session.answeredCount += 1;
  } catch (err) {
    await msg.reply(
      `Hmm, I couldn't save that one (${err instanceof Error ? err.message : "unknown error"}). Could you try rephrasing, or say "stop" to end?`,
    );
    return true;
  }

  const next = pickNextQuestion({ bank: session.bank, askedTopics: session.askedTopics });
  const ackPrefix =
    kept.status === "needs_review"
      ? "Noted — flagged for review (contains something sensitive or time-sensitive)."
      : "Noted, thanks!";

  if (!next) {
    store.end(conversationId);
    await msg.reply(`${ackPrefix} ${WRAP_UP_NO_MORE_QUESTIONS}`);
    return true;
  }

  session.askedTopics.add(next.topic);
  await msg.reply(`${ackPrefix}\n\nNext: ${next.question}`);
  return true;
}
