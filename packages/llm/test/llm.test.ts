import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatJson, extractJson, JsonReplyError, openAiCompatible, scriptedModel, stripModelNoise } from "../src/index.ts";

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

describe("openAiCompatible", () => {
  it("posts to /chat/completions with auth and maps usage", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const model = openAiCompatible({
      baseUrl: "https://example.test/v1/",
      model: "nvidia/test",
      apiKey: "k",
      fetch: async (url, init) => {
        seen = { url, init };
        return Response.json({
          model: "nvidia/test",
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        });
      },
    });
    const result = await model.chat(user("hello"), { maxTokens: 16 });
    expect(seen!.url).toBe("https://example.test/v1/chat/completions");
    expect((seen!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(seen!.init!.body as string)).toMatchObject({ model: "nvidia/test", max_tokens: 16 });
    expect(result).toEqual({ content: "hi", model: "nvidia/test", usage: { prompt_tokens: 7, completion_tokens: 2 } });
  });

  it("throws with the status on HTTP errors", async () => {
    const model = openAiCompatible({
      baseUrl: "https://example.test/v1",
      model: "m",
      fetch: async () => new Response("nope", { status: 401 }),
    });
    await expect(model.chat(user("x"), { maxTokens: 1 })).rejects.toMatchObject({ status: 401 });
  });
});
