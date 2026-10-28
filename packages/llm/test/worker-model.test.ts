import { describe, expect, it } from "vitest";
import { chatJson, workerModel, type FromWorker, type ToWorker, type WorkerLike } from "../src/index.ts";
import { z } from "zod";

/** A stand-in worker: records what it was sent and lets the test reply. */
function fakeWorker() {
  const listeners = new Set<(event: { data: FromWorker }) => void>();
  const sent: ToWorker[] = [];
  const worker: WorkerLike = {
    postMessage: (message) => void sent.push(message),
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  const reply = (data: FromWorker) => { for (const l of [...listeners]) l({ data }); };
  const lastChat = () => sent.filter((m): m is Extract<ToWorker, { type: "chat" }> => m.type === "chat").at(-1)!;
  return { worker, sent, reply, lastChat, listening: () => listeners.size };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const ask = [{ role: "user" as const, content: "Hi" }];

describe("workerModel", () => {
  it("loads once, reports download progress, then answers with reasoning stripped", async () => {
    const w = fakeWorker();
    const model = workerModel(w.worker, "nemotron");
    const seen: number[] = [];
    const loaded = model.load((p) => seen.push(p));
    void model.load();
    expect(w.sent.filter((m) => m.type === "load")).toHaveLength(1);
    w.reply({ type: "progress", percent: 40 });
    w.reply({ type: "ready" });
    await loaded;
    expect(seen).toEqual([40]);

    const answer = model.chat(ask, { maxTokens: 50 });
    await tick();
    expect(w.lastChat()).toMatchObject({ messages: ask, maxTokens: 50, temperature: 0.4 });
    w.reply({ type: "done", id: w.lastChat().id + 1, text: "not mine", promptTokens: 0, completionTokens: 1 });
    w.reply({ type: "done", id: w.lastChat().id, text: "<think>hmm</think> Hello!", promptTokens: 3, completionTokens: 2 });
    expect(await answer).toEqual({ content: "Hello!", model: "nemotron", usage: { prompt_tokens: 3, completion_tokens: 2 } });
  });

  it("lets a failed download be tried again", async () => {
    const w = fakeWorker();
    const model = workerModel(w.worker, "nemotron");
    const first = model.load();
    w.reply({ type: "error", message: "no WebGPU" });
    await expect(first).rejects.toThrow("no WebGPU");
    const second = model.load();
    expect(w.sent.filter((m) => m.type === "load")).toHaveLength(2);
    w.reply({ type: "ready" });
    await expect(second).resolves.toBeUndefined();
  });

  it("passes on a failed answer and stops the worker when the caller gives up", async () => {
    const w = fakeWorker();
    const model = workerModel(w.worker, "nemotron");
    void model.load();
    w.reply({ type: "ready" });

    const failing = model.chat(ask, { maxTokens: 5 });
    await tick();
    w.reply({ type: "error", id: w.lastChat().id, message: "out of GPU memory" });
    await expect(failing).rejects.toThrow("out of GPU memory");

    const controller = new AbortController();
    const cancelled = model.chat(ask, { maxTokens: 5, signal: controller.signal });
    await tick();
    controller.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(w.sent.at(-1)).toEqual({ type: "interrupt" });
    expect(w.listening()).toBe(1); // only the progress listener remains
  });

  it("works with the JSON helper the privacy pipeline uses", async () => {
    const w = fakeWorker();
    const model = workerModel(w.worker, "nemotron");
    void model.load();
    w.reply({ type: "ready" });
    const reply = chatJson(model, ask, z.object({ ok: z.boolean() }), { maxTokens: 20 });
    await tick();
    w.reply({ type: "done", id: w.lastChat().id, text: '```json\n{"ok": true}\n```', promptTokens: 0, completionTokens: 5 });
    expect(await reply).toEqual({ ok: true });
  });
});
