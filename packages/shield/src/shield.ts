import { randomId, shuffle } from "@zireh/crypto";
import { makeDecoys } from "@zireh/decoy";
import { checkLeak, generalize, passes, type LeakReport } from "@zireh/leakcheck";
import type { ChatModel } from "@zireh/llm";
import { applyTable, findLeaks, redactText, restore, withHints } from "@zireh/redact";
import { LEVELS, type ChatMessage, type OutboundPiece, type PrivacyLevel, type Pseudonym, type TraceStep } from "@zireh/schema";
import { reassemble, splitTask, type Reassembled } from "@zireh/split";

/** Shared by every outbound call from every user: cache hits on it identify no one. */
export const SYSTEM_PROMPT = `You are a careful research assistant. Answer concisely and factually.
If you don't know something, say so plainly instead of guessing; never invent facts about specific
people, companies or events. Values in brackets like [PERSON_1] are hidden on purpose: keep them
exactly as written and never guess them.`;

const LOCAL_PROMPT = `You are a careful research assistant working only from what the user gives you.
Use the user's notes and evidence. If they don't contain the answer, say what is missing instead of
guessing; never invent facts about specific people, companies or events. Answer concisely.`;

export interface ShieldInput {
  readonly task: string;
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
  readonly onStep?: (step: TraceStep) => void;
  /** Called as soon as values are hidden, before anything else runs (drives the redaction view). */
  readonly onRedacted?: (table: readonly Pseudonym[]) => void;
}

export async function compile(local: ChatModel, input: ShieldInput, hooks: CompileHooks = {}): Promise<Plan> {
  const onStep = hooks.onStep;
  const policy = LEVELS[input.level];
  const trace: TraceStep[] = [];
  const step = (s: TraceStep) => {
    trace.push(s);
    onStep?.(s);
  };
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 1. redact — task and context share one table so placeholders agree everywhere.
  const contextText = (input.context ?? []).join("\n\n");
  const combined = contextText ? `${contextText}\n\nTask: ${input.task}` : input.task;
  const red = await redactText(local, combined, input.table);
  const redactedTask = applyTable(input.task, red.table);
  const described = withHints(red.text, red.table);
  hooks.onRedacted?.(red.table);
  step({
    stage: "redact",
    title: `Hid ${red.table.length} value${red.table.length === 1 ? "" : "s"}`,
    detail: red.added.length
      ? `New this time: ${red.added.map((p) => `${p.original} → ${p.hint ?? p.placeholder}`).join(", ")}` // trace stays on this device
      : "No new identifying values found.",
    before: combined,
    after: described,
  });

  // 2. route — the local level never leaves the device.
  if (!policy.cloud) {
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
  step({ stage: "route", title: "Sending to the cloud model", detail: `Privacy level: ${input.level}.` });

  // 3. split
  // Placeholders become vague descriptions in code ("a large city in Nigeria"), so the provider
  // gets an answerable question without the hidden values. Then the local model rewrites or splits.
  // The model may reintroduce a hidden value while rewriting; scrub every question in code.
  const questions = (await splitTask(local, described, policy.split ? undefined : 1)).map((q) => withHints(applyTable(q, red.table), red.table));
  step({
    stage: "split",
    title: policy.split ? `Split into ${questions.length} independent question${questions.length === 1 ? "" : "s"}` : "Rewritten as one general question",
    detail: questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
  });

  // 4. leakcheck — one generalization attempt, then block.
  const approved: { question: string; score: number }[] = [];
  const blocked: BlockedPiece[] = [];
  for (const q of questions) {
    let text = q;
    let report = await checkLeak(local, text, red.table);
    if (!passes(report, policy.leakThreshold) && report.leakedOriginals.length === 0) {
      text = applyTable(await generalize(local, text, report), red.table);
      report = await checkLeak(local, text, red.table);
    }
    if (passes(report, policy.leakThreshold)) approved.push({ question: text, score: report.score });
    else blocked.push({ question: text, report });
  }
  step({
    stage: "leakcheck",
    title: blocked.length ? `Blocked ${blocked.length} of ${questions.length}` : "All pieces passed",
    detail: [
      ...approved.map((a) => `Leak score ${a.score} ≤ ${policy.leakThreshold}: ${a.question}`),
      ...blocked.map((b) => `Blocked (score ${b.report.score}): ${b.report.inferences.join("; ")}`),
    ].join("\n"),
  });

  // 5. decoy + 6. order
  const salt = policy.split ? undefined : input.salt;
  const pieces: OutboundPiece[] = [];
  for (const a of approved) {
    pieces.push({ id: randomId(), role: "real", question: a.question, messages: buildMessages(a.question, salt), maxTokens, leakScore: a.score });
    for (const d of await makeDecoys(local, a.question, policy.decoys, (text) => findLeaks(text, red.table).length === 0)) {
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
    detail: decoyCount ? `${approved.length} real and ${decoyCount} decoy requests, shuffled. Each goes on its own Tor circuit.` : "This level sends no cover traffic.",
  });
  step({
    stage: "order",
    title: "Cache-safe prompt order",
    detail: salt
      ? "Shared system prompt, then a per-case salt, then the content."
      : "Shared system prompt, then the content. No case salt, so pieces can't be grouped.",
  });

  return { level: input.level, task: input.task, redactedTask, table: red.table, pieces: shuffled, blocked, trace };
}

/** Combine answers for the real pieces (decoy answers are dropped) and restore pseudonyms locally. */
export async function finish(
  local: ChatModel,
  plan: Plan,
  answers: ReadonlyMap<string, string>,
  onStep?: (step: TraceStep) => void,
): Promise<Outcome> {
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

  const citations = await reassemble(local, plan.redactedTask, answered);
  const last: TraceStep = {
    stage: "reassemble",
    title: "Combined on this device",
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
