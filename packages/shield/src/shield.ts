import { randomId, shuffle } from "@zireh/crypto";
import { makeDecoys, stockDecoys, tooSimilar } from "./decoy.ts";
import { checkLeak, generalize, passes, type LeakReport } from "./leakcheck.ts";
import { abortableModel, type ChatModel } from "@zireh/llm";
import { applyTable, findLeaks, redactText, redactWithoutModel, restore, withHints } from "./redact/index.ts";
import { LEVELS, type ChatMessage, type OutboundPiece, type PrivacyLevel, type Pseudonym, type TraceStep } from "@zireh/schema";
import { reassemble, splitTask, type Reassembled } from "./split.ts";

/** Shared by every outbound call from every user: cache hits on it identify no one. */
export const SYSTEM_PROMPT = `You are a careful research assistant. Answer concisely and factually.
If you don't know something, say so plainly instead of guessing; never invent facts about specific
people, companies or events. Values in brackets like [PERSON_1] are hidden on purpose: keep them
exactly as written and never guess them.`;

const STANDALONE_PROMPT = `You rewrite a follow-up question so it can be understood on its own, by someone who never saw the conversation.
Replace words that point back ("they", "that company", "the second one", "what about") with what they refer to.
Keep the person's intent, wording and language. Do not answer it and do not add anything new.
Reply with the rewritten question only.`;

const LOCAL_PROMPT = `You are a careful research assistant working only from what the user gives you.
Use the user's notes and evidence. If they don't contain the answer, say what is missing instead of
guessing; never invent facts about specific people, companies or events. Answer concisely.`;

/** One earlier question and answer in the same thread. */
export interface Turn {
  readonly question: string;
  readonly answer: string;
}

export interface ShieldInput {
  readonly task: string;
  /** Earlier turns of the thread. Used on this device to make a follow-up stand alone; never sent. */
  readonly history?: readonly Turn[];
  readonly context?: readonly string[]; // selected evidence text, plaintext
  readonly level: PrivacyLevel;
  readonly table: readonly Pseudonym[];
  readonly salt: string;
  readonly maxTokens?: number;
}

export interface BlockedPiece {
  readonly question: string;
  readonly report: LeakReport;
}

export interface Plan {
  readonly level: PrivacyLevel;
  readonly task: string; // original, stays local
  readonly redactedTask: string;
  readonly table: Pseudonym[];
  readonly pieces: OutboundPiece[]; // real + decoys, shuffled; empty when answered locally
  readonly blocked: BlockedPiece[];
  readonly localAnswer?: string;
  readonly trace: TraceStep[];
}

export interface Outcome {
  readonly answer: string; // pseudonyms restored, for the user
  readonly redactedAnswer: string;
  readonly citations: Reassembled;
  readonly trace: TraceStep[];
}

const DEFAULT_MAX_TOKENS = 600;

function buildMessages(content: string, salt: string | undefined): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: salt ? `Session ${salt}\n\n${content}` : content },
  ];
}

/**
 * Compile a task into the calls that may leave the device. Every stage appends to the trace.
 * Any stage error propagates: the caller sends nothing (fail closed).
 */
export interface CompileHooks {
  readonly signal?: AbortSignal;
  readonly onStep?: (step: TraceStep) => void;
  /** Called as soon as values are hidden, before anything else runs (drives the redaction view). */
  readonly onRedacted?: (table: readonly Pseudonym[]) => void;
}

/** Thrown when a level needs the on-device model and none is connected. */
export class NeedsLocalModel extends Error {}

/**
 * `local` is the on-device model, or undefined when none is connected. Without it nothing is
 * guessed: hiding is by pattern (see redactWithoutModel), the task goes out as one question with no
 * rewrite, the leak check is the exact-match one, and decoys come from a fixed list.
 */
export async function compile(local: ChatModel | undefined, input: ShieldInput, hooks: CompileHooks = {}): Promise<Plan> {
  hooks.signal?.throwIfAborted();
  local = local && abortableModel(local, hooks.signal);
  const onStep = hooks.onStep;
  const policy = LEVELS[input.level];
  const trace: TraceStep[] = [];
  const step = (s: TraceStep) => {
    trace.push(s);
    onStep?.(s);
  };
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 0. standalone — a follow-up is rewritten here, on this device, into a question that makes
  // sense alone. Only that goes on: the provider never sees the conversation, so questions from
  // one thread look as unrelated as questions from different people.
  let task = input.task;
  if (local && input.history?.length) {
    const transcript = input.history.slice(-4).map((t) => `Q: ${t.question}\nA: ${t.answer.slice(0, 1500)}`).join("\n\n");
    const { content } = await local.chat(
      [
        { role: "system", content: STANDALONE_PROMPT },
        { role: "user", content: `Conversation so far:\n${transcript}\n\nFollow-up: ${input.task}` },
      ],
      { maxTokens: 300, temperature: 0 },
    );
    const rewritten = content.trim().replace(/^["“']|["”']$/g, "").trim().slice(0, 4000);
    if (rewritten.length >= 3) task = rewritten;
    step({ stage: "standalone", title: "Made the follow-up stand alone", detail: "Rewritten on this device, so the provider gets a fresh question, not the conversation.", before: input.task, after: task });
  }

  // 1. redact — task and context share one table so placeholders agree everywhere.
  const contextText = (input.context ?? []).join("\n\n");
  const combined = contextText ? `${contextText}\n\nTask: ${task}` : task;
  // Without the model only Standard can run: Local only needs it to answer, and Private and
  // Paranoid promise splitting and rewriting that pattern matching can't do.
  if (!local && input.level !== "standard") throw new NeedsLocalModel(`${input.level[0]!.toUpperCase()}${input.level.slice(1)} needs on-device AI. Turn it on in Settings, or use Standard.`);
  const red = local ? await redactText(local, combined, input.table) : redactWithoutModel(combined, input.table);
  const redactedTask = applyTable(task, red.table);
  const described = withHints(red.text, red.table);
  hooks.onRedacted?.(red.table);
  // Count what this question actually contained, not everything the case has ever hidden.
  const hiddenHere = findLeaks(combined, red.table).length;
  step({
    stage: "redact",
    title: hiddenHere ? `Hid ${hiddenHere} value${hiddenHere === 1 ? "" : "s"}` : "Nothing to hide found",
    detail: red.added.length
      ? `New this time: ${red.added.map((p) => `${p.original} → ${p.hint ?? p.placeholder}`).join(", ")}` // trace stays on this device
      : "No new identifying values found.",
    ...(local ? {} : { detail: `${red.added.length ? `New this time: ${red.added.map((p) => `${p.original} → ${p.hint ?? p.placeholder}`).join(", ")}. ` : ""}No on-device AI, so every name-like phrase was hidden.` }),
    before: combined,
    after: described,
  });

  // 2. route — the local level never leaves the device.
  if (!policy.cloud && local) {
    const { content } = await local.chat(
      [
        { role: "system", content: LOCAL_PROMPT },
        { role: "user", content: combined },
      ],
      { maxTokens, temperature: 0.3 },
    );
    step({ stage: "route", title: "Answered on this device", detail: "Local only: nothing was sent." });
    return { level: input.level, task: input.task, redactedTask, table: red.table, pieces: [], blocked: [], localAnswer: content, trace };
  }
  step({ stage: "route", title: "Will go to the cloud model", detail: `Privacy level: ${input.level}. Nothing has been sent yet.` });

  // 3. split
  // Placeholders become vague descriptions in code ("a large city in Nigeria"), so the provider
  // gets an answerable question without the hidden values. Then the local model rewrites or splits.
  // The model may reintroduce a hidden value while rewriting; scrub every question in code.
  const questions = (local ? await splitTask(local, described, policy.split ? undefined : 1) : [described]).map((q) => withHints(applyTable(q, red.table), red.table));
  step({
    stage: "split",
    title: !local ? "Kept as one question (no on-device AI to rewrite it)" : policy.split ? `Split into ${questions.length} independent question${questions.length === 1 ? "" : "s"}` : "Rewritten as one general question",
    detail: questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
  });

  // 4. leakcheck — one generalization attempt, then block.
  const approved: { question: string; score: number }[] = [];
  const blocked: BlockedPiece[] = [];
  for (const q of questions) {
    let text = q;
    let report: LeakReport = local ? await checkLeak(local, text, red.table) : { score: 0, inferences: [], leakedOriginals: findLeaks(text, red.table) };
    if (!local) report = report.leakedOriginals.length ? { ...report, score: 10, inferences: ["A hidden value is still in the text."] } : report;
    if (local && !passes(report, policy.leakThreshold) && report.leakedOriginals.length === 0) {
      text = applyTable(await generalize(local, text, report), red.table);
      report = await checkLeak(local, text, red.table);
    }
    if (passes(report, policy.leakThreshold)) approved.push({ question: text, score: report.score });
    else blocked.push({ question: text, report });
  }
  // Without the model there is no inference check, only an exact match for hidden values; say so.
  step({
    stage: "leakcheck",
    title: blocked.length ? `Blocked ${blocked.length} of ${questions.length}` : local ? "All pieces passed the leak check" : "No hidden value left in the text",
    detail: local
      ? [
          ...approved.map((a) => `Leak score ${a.score} ≤ ${policy.leakThreshold}: ${a.question}`),
          ...blocked.map((b) => `Blocked (score ${b.report.score}): ${b.report.inferences.join("; ")}`),
        ].join("\n")
      : blocked.length
        ? "A hidden value was still in the text, so it was not sent."
        : "Checked by exact match only. Without on-device AI, nothing judged what the provider could infer.",
  });

  // 5. decoy + 6. order
  const salt = policy.split ? undefined : input.salt;
  const pieces: OutboundPiece[] = [];
  const covers: string[] = [];
  for (const a of approved) {
    pieces.push({ id: randomId(), role: "real", question: a.question, messages: buildMessages(a.question, salt), maxTokens, ...(local ? { leakScore: a.score } : {}) });
    const accept = (text: string) => findLeaks(text, red.table).length === 0 && approved.every((real) => !tooSimilar(text, real.question)) && covers.every((cover) => cover.toLowerCase() !== text.toLowerCase() && !tooSimilar(cover, text));
    for (const d of local ? await makeDecoys(local, a.question, policy.decoys, accept) : stockDecoys(a.question, policy.decoys, accept)) {
      covers.push(d);
      pieces.push({ id: randomId(), role: "decoy", question: d, messages: buildMessages(d, salt), maxTokens });
    }
  }
  // One gate for every outbound type, after all generation and message decoration.
  const gated = pieces.map((piece) => {
    const question = withHints(applyTable(piece.question, red.table), red.table);
    const messages = buildMessages(question, salt);
    if (findLeaks(JSON.stringify(messages), red.table).length) throw new Error("outbound privacy gate blocked a hidden value");
    return { ...piece, question, messages };
  });
  const shuffled = shuffle(gated);
  const decoyCount = shuffled.filter((p) => p.role === "decoy").length;
  step({
    stage: "decoy",
    title: decoyCount ? `Added ${decoyCount} decoy${decoyCount === 1 ? "" : "s"}` : "No decoys",
    detail: decoyCount ? `${approved.length} real and ${decoyCount} decoy requests, shuffled. Each will go out on its own.${local ? "" : " Decoys came from a fixed list, not written for this question."}` : "This level sends no cover traffic.",
  });
  step({
    stage: "order",
    title: "Prompt layout",
    detail: salt
      ? "Shared system prompt, then a per-case salt, then the content."
      : "Shared system prompt, then the content. No case salt, so pieces can't be grouped.",
  });

  return { level: input.level, task: input.task, redactedTask, table: red.table, pieces: shuffled, blocked, trace };
}

/** Combine answers for the real pieces (decoy answers are dropped) and restore pseudonyms locally. */
export async function finish(
  local: ChatModel | undefined,
  plan: Plan,
  answers: ReadonlyMap<string, string>,
  onStep?: (step: TraceStep) => void,
  signal?: AbortSignal,
): Promise<Outcome> {
  signal?.throwIfAborted();
  local = local && abortableModel(local, signal);
  const trace = [...plan.trace];
  if (plan.localAnswer !== undefined) {
    return {
      answer: plan.localAnswer,
      redactedAnswer: plan.localAnswer,
      citations: { text: plan.localAnswer, cited: [], invalidCitations: [], uncited: [] },
      trace,
    };
  }
  const real = plan.pieces.filter((p) => p.role === "real");
  const answered = real
    .filter((p) => answers.has(p.id))
    .map((p, i) => ({ label: `A${i + 1}`, question: p.question, answer: answers.get(p.id)! }));
  const dropped = plan.pieces.filter((p) => p.role === "decoy" && answers.has(p.id)).length;
  if (answered.length === 0) throw new Error("no real piece was answered");

  // Without the on-device model the answers are shown one after another instead of merged.
  const citations: Reassembled = local
    ? await reassemble(local, plan.redactedTask, answered)
    : { text: answered.map((a) => (answered.length > 1 ? `${a.question}\n\n${a.answer}` : a.answer)).join("\n\n"), cited: [], invalidCitations: [], uncited: [] };
  const last: TraceStep = {
    stage: "reassemble",
    title: local ? "Combined on this device" : answered.length > 1 ? "Answers shown one after another" : "Answer shown as it came back",
    detail: [
      `Used ${answered.length} answer${answered.length === 1 ? "" : "s"}, discarded ${dropped} decoy answer${dropped === 1 ? "" : "s"}.`,
      citations.invalidCitations.length ? `Unsupported citations flagged: ${citations.invalidCitations.join(", ")}.` : "",
      answered.length < real.length ? `${real.length - answered.length} piece(s) got no answer.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
  trace.push(last);
  onStep?.(last);
  return { answer: restore(citations.text, plan.table), redactedAnswer: citations.text, citations, trace };
}
