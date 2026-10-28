import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatJson, extractJson, JsonReplyError, scriptedModel, stripModelNoise } from "../src/index.ts";

const user = (content: string) => [{ role: "user" as const, content }];

describe("stripModelNoise / extractJson", () => {
  it("drops think blocks and fences", () => {
    expect(stripModelNoise("<think>hmm {no}</think>```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("finds the first balanced object, ignoring braces inside strings", () => {
    expect(extractJson('Sure! {"q": "a } b", "n": {"x": 1}} trailing')).toBe('{"q": "a } b", "n": {"x": 1}}');
    expect(extractJson("no json here")).toBeUndefined();
  });
});

describe("chatJson", () => {
  const Schema = z.object({ score: z.number().min(0).max(100) });

  it("parses a valid reply", async () => {
    const model = scriptedModel(() => '<think>...</think>{"score": 42}');
    expect(await chatJson(model, user("rate"), Schema, { maxTokens: 50 })).toEqual({ score: 42 });
  });

  it("retries once with the validation problem, then succeeds", async () => {
    let n = 0;
    const model = scriptedModel(() => (n++ === 0 ? '{"score": 500}' : '{"score": 5}'));
    expect(await chatJson(model, user("rate"), Schema, { maxTokens: 50 })).toEqual({ score: 5 });
    expect(model.calls[1]!.at(-1)!.content).toContain("score");
  });

  it("fails closed after retries", async () => {
    const model = scriptedModel(() => "I'd rather not.");
    await expect(chatJson(model, user("rate"), Schema, { maxTokens: 50 })).rejects.toBeInstanceOf(JsonReplyError);
  });
});
