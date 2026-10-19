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
};

/** A local model that answers each stage by recognizing its system prompt. */
function fakeLocal(r: Replies) {
  return scriptedModel((messages: readonly ChatMessage[]) => {
    const sys = messages[0]!.content;
    const user = messages[1]!.content;
    if (sys.includes("general kind of thing")) return JSON.stringify({ hints: {} });
    if (sys.includes("identifying details")) return JSON.stringify(r.entities ?? { entities: [] });
    if (sys.includes("the user's request")) return JSON.stringify({ pieces: r.pieces ?? [user] });
    if (sys.includes("You are an AI provider")) return JSON.stringify({ score: r.leak?.(user) ?? 10, inferences: ["topic only"] });
    if (sys.includes("Rewrite the message")) return JSON.stringify({ text: r.generalized ?? user });
    if (sys.includes("decoy questions")) return JSON.stringify({ decoys: r.decoys ?? [] });
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
    expect(piece.messages[1]!.content).toBe(`Session ${salt}\n\nIs [PERSON_1] at risk after publishing the [PLACE_1] port report?`);
    expect(JSON.stringify(plan.pieces)).not.toMatch(/Ada|Lagos/);
  });

  it("paranoid level splits, adds 3 decoys per piece, and never salts", async () => {
    const decoys = [
      "How do journalists in a large coastal city assess threats after a big story?",
      "What protections exist for whistleblowers at shipping firms generally?",
      "How should a reporter document intimidation for a press union?",
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
      decoys: ["Risks for mining reporters?"],
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
