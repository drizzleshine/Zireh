import { scriptedModel } from "@zireh/llm";
import type { ChatMessage } from "@zireh/schema";
import { describe, expect, it } from "vitest";
import { compile, finish, SYSTEM_PROMPT } from "../src/index.ts";

type Replies = {
  entities?: object;
  pieces?: string[];
  leak?: (text: string) => number;
  decoys?: string[];
  combined?: string;
  generalized?: string;
  standalone?: string;
};

/** A local model that answers each stage by recognizing its system prompt. */
function fakeLocal(r: Replies) {
  return scriptedModel((messages: readonly ChatMessage[]) => {
    const sys = messages[0]!.content;
    const user = messages[1]!.content;
    if (sys.includes("rewrite a follow-up")) return r.standalone ?? user;
    if (sys.includes("general kind of thing")) return JSON.stringify({ hints: {} });
    if (sys.includes("say what it names")) return JSON.stringify({ items: [] });
    if (sys.includes("identifying details")) return JSON.stringify(r.entities ?? { entities: [] });
    if (sys.includes("the user's request")) return JSON.stringify({ pieces: r.pieces ?? [user] });
    if (sys.includes("You are an AI provider")) return JSON.stringify({ score: r.leak?.(user) ?? 10, inferences: ["topic only"] });
    if (sys.includes("Rewrite the message")) return JSON.stringify({ text: r.generalized ?? user });
    if (sys.includes("different people might ask")) return JSON.stringify({ decoys: r.decoys ?? [] });
    if (sys.includes("combine answers")) return r.combined ?? "combined [A1]";
    return "local answer";
  });
}

const salt = "ab".repeat(32);
const task = "Is Ada Obi at risk after publishing the Lagos port report?";
const entities = { entities: [{ text: "Ada Obi", kind: "person" }, { text: "Lagos", kind: "place" }] };

describe("compile", () => {
  it("local level answers on the device and sends nothing", async () => {
    const plan = await compile(fakeLocal({ entities }), { task, level: "local", table: [], salt });
    expect(plan.pieces).toEqual([]);
    expect(plan.localAnswer).toBe("local answer");
  });

  it("standard level sends one redacted, salted piece and no decoys", async () => {
    const plan = await compile(fakeLocal({ entities }), { task, level: "standard", table: [], salt });
    expect(plan.pieces).toHaveLength(1);
    const piece = plan.pieces[0]!;
    expect(piece.role).toBe("real");
    expect(piece.messages[0]!.content).toBe(SYSTEM_PROMPT);
    // Hidden values reach the provider only as vague descriptions (generic ones here).
    expect(piece.messages[1]!.content).toBe(`Session ${salt}\n\nIs a person at risk after publishing a location port report?`);
    expect(JSON.stringify(plan.pieces)).not.toMatch(/Ada|Lagos/);
  });

  it("paranoid level splits, adds 3 decoys per piece, and never salts", async () => {
    const decoys = [
      "How do journalists in a large coastal city assess threats after a big story?",
      "What protections exist for whistleblowers at shipping firms generally?",
      "How should a reporter document intimidation for a press union?",
      "Which trees survive coastal salt spray best?",
      "How do ocean currents affect sailing routes?",
      "What equipment is needed for hiking in heavy rain?",
    ];
    const plan = await compile(
      fakeLocal({
        entities,
        pieces: ["What risks do port-industry reporters face after exposés?", "What legal protections exist for journalists in [PLACE_1]?"],
        decoys,
      }),
      { task, level: "paranoid", table: [], salt },
    );
    expect(plan.pieces.filter((p) => p.role === "real")).toHaveLength(2);
    expect(plan.pieces.filter((p) => p.role === "decoy")).toHaveLength(6);
    for (const p of plan.pieces) expect(p.messages[1]!.content).not.toContain(salt);
  });

  it("generalizes a risky piece once, then blocks it if still risky", async () => {
    const plan = await compile(
      fakeLocal({
        entities,
        pieces: ["Who threatened the editor of the port report last Tuesday?", "General press-freedom law questions?"],
        leak: (text) => (text.includes("editor") ? 90 : 10),
        generalized: "Who threatened the editor recently?",
        decoys: ["Which press-freedom laws cover freelance photographers?"],
      }),
      { task, level: "private", table: [], salt },
    );
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.question).toBe("Who threatened the editor recently?");
    expect(plan.pieces.filter((p) => p.role === "real").map((p) => p.question)).toEqual(["General press-freedom law questions?"]);
  });

  it("fails closed when redaction fails", async () => {
    const broken = scriptedModel(() => "no json");
    await expect(compile(broken, { task, level: "standard", table: [], salt })).rejects.toThrow();
  });
});

describe("finish", () => {
  it("drops decoy answers, checks citations and restores pseudonyms", async () => {
    const local = fakeLocal({
      entities,
      pieces: ["Risks for port reporters?", "Press law in [PLACE_1]?"],
      decoys: ["Best soil for tomatoes?", "How should bicycle tires be repaired?"],
      combined: "[PERSON_1] faces moderate risk [A1]; [PLACE_1] law offers little protection [A2] [A9].",
    });
    const plan = await compile(local, { task, level: "private", table: [], salt });
    const answers = new Map(plan.pieces.map((p) => [p.id, `answer to ${p.question}`]));
    const outcome = await finish(local, plan, answers);
    expect(outcome.answer).toBe("Ada Obi faces moderate risk [A1]; Lagos law offers little protection [A2] [A9].");
    expect(outcome.citations.invalidCitations).toEqual(["A9"]);
    expect(outcome.trace.at(-1)!.detail).toContain("discarded 2 decoy answers");
  });
});

describe("F03 final outbound gate", () => {
  const input = { task: "How can reporters document intimidation?", level: "private" as const, salt, table: [{ original: "Lagos", placeholder: "[PLACE_1]", kind: "place" as const, hint: "a city" }] };
  it("replaces decoys containing hidden values and checks all wire messages", async () => {
    const plan = await compile(fakeLocal({ pieces: [input.task], decoys: ["Where can tourists buy train tickets in Lagos?", "Which trees tolerate coastal salt spray best?"] }), input);
    expect(plan.pieces).toHaveLength(2);
    expect(JSON.stringify(plan.pieces)).not.toContain("Lagos");
  });
  it("sends nothing if the promised number of safe decoys cannot be generated", async () => {
    await expect(compile(fakeLocal({ pieces: [input.task], decoys: ["Where can tourists buy train tickets in Lagos?"] }), input)).rejects.toThrow(/decoy/);
  });
});

it("uses distinct cover questions across the whole split plan", async () => {
  const covers = ["How do bakers keep sourdough starters alive?", "Which trees survive coastal salt spray best?", "How should bicycle brakes be maintained?", "Which stars are visible during winter?", "How do ocean currents affect sailing routes?", "What equipment is needed for hiking?"];
  const plan = await compile(fakeLocal({ entities, pieces: ["What risks do port reporters face?", "What press laws apply in [PLACE_1]?"], decoys: covers }), { task, level: "paranoid", table: [], salt });
  const decoys = plan.pieces.filter((piece) => piece.role === "decoy").map((piece) => piece.question.toLowerCase());
  expect(new Set(decoys).size).toBe(6);
});

describe("follow-ups in a thread", () => {
  const history = [{ question: "Who runs Harbor Line Freight?", answer: "Public filings list a single director." }];

  it("sends the standalone rewrite, never the conversation", async () => {
    const local = fakeLocal({ standalone: "Who owns the parent company of a regional freight firm?", leak: () => 0 });
    const plan = await compile(local, { task: "And who owns their parent?", history, level: "standard", table: [], salt: "s" });
    const outbound = JSON.stringify(plan.pieces.map((p) => p.messages));
    expect(outbound).toContain("parent company of a regional freight firm");
    expect(outbound).not.toContain("single director");
    expect(outbound).not.toContain("And who owns their parent?");
    expect(plan.task).toBe("And who owns their parent?");
    expect(plan.trace[0]!.stage).toBe("standalone");
  });

  it("without history, skips the rewrite", async () => {
    const plan = await compile(fakeLocal({ leak: () => 0 }), { task: "Who regulates port inspections?", level: "standard", table: [], salt: "s" });
    expect(plan.trace.some((t) => t.stage === "standalone")).toBe(false);
  });
});

describe("the step trace tells the truth", () => {
  it("without on-device AI, claims no leak score and counts only values in this question", async () => {
    const table = [{ original: "Old Name", placeholder: "[PERSON_1]", kind: "person" as const, hint: "a person" }];
    const plan = await compile(undefined, { task: "Is Ada Obi safe?", level: "standard", table, salt: "s" });
    const redact = plan.trace.find((s) => s.stage === "redact")!;
    const leak = plan.trace.find((s) => s.stage === "leakcheck")!;
    expect(redact.title).toBe("Hid 1 value");
    expect(leak.title).toBe("No hidden value left in the text");
    expect(leak.detail).toMatch(/exact match only/);
    expect(plan.pieces.every((p) => p.leakScore === undefined)).toBe(true);
    expect(plan.trace.find((s) => s.stage === "route")!.title).toBe("Will go to the cloud model");
  });
});
