import type { ChatMessage } from "@zireh/schema";
import { ModelError, type ChatModel } from "./model.ts";
import { stripModelNoise } from "./json.ts";

/**
 * A model that runs in a Web Worker (or anything that speaks the same messages), so the
 * on-device model never blocks the page. The worker side lives in the app; this is the
 * protocol plus a `ChatModel` on top of it, kept here so it can be tested without a browser.
 */
export type ToWorker =
  | { type: "load" }
  | { type: "chat"; id: number; messages: readonly ChatMessage[]; maxTokens: number; temperature: number }
  | { type: "interrupt" };

export type FromWorker =
  | { type: "progress"; percent: number }
  | { type: "ready" }
  | { type: "done"; id: number; text: string; promptTokens: number; completionTokens: number }
  | { type: "error"; id?: number; message: string };

export interface WorkerLike {
  postMessage(message: ToWorker): void;
  addEventListener(type: "message", listener: (event: { data: FromWorker }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: FromWorker }) => void): void;
}

export interface WorkerModel extends ChatModel {
  /** Download (first time) and start the model. Safe to call more than once. */
  load(onProgress?: (percent: number) => void): Promise<void>;
}

export function workerModel(worker: WorkerLike, id: string): WorkerModel {
  let next = 0;
  let loading: Promise<void> | undefined;
  const progress = new Set<(percent: number) => void>();
  worker.addEventListener("message", ({ data }) => {
    if (data.type === "progress") for (const report of progress) report(data.percent);
  });

  const load = (onProgress?: (percent: number) => void) => {
    if (onProgress) progress.add(onProgress);
    loading ??= new Promise<void>((resolve, reject) => {
      const listen = ({ data }: { data: FromWorker }) => {
        if (data.type !== "ready" && !(data.type === "error" && data.id === undefined)) return;
        worker.removeEventListener("message", listen);
        if (data.type === "ready") resolve();
        else {
          loading = undefined; // a failed download can be tried again
          reject(new ModelError(data.message));
        }
      };
      worker.addEventListener("message", listen);
      worker.postMessage({ type: "load" });
    });
    return loading;
  };

  return {
    id,
    load,
    async chat(messages, { maxTokens, temperature = 0.4, signal }) {
      signal?.throwIfAborted();
      await load();
      const call = ++next;
      return new Promise((resolve, reject) => {
        const finish = () => {
          worker.removeEventListener("message", listen);
          signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          finish();
          worker.postMessage({ type: "interrupt" });
          reject(signal!.reason);
        };
        const listen = ({ data }: { data: FromWorker }) => {
          if (!("id" in data) || data.id !== call) return;
          finish();
          if (data.type === "done")
            resolve({ content: stripModelNoise(data.text), model: id, usage: { prompt_tokens: data.promptTokens, completion_tokens: data.completionTokens } });
          else if (data.type === "error") reject(new ModelError(data.message));
        };
        worker.addEventListener("message", listen);
        signal?.addEventListener("abort", abort, { once: true });
        worker.postMessage({ type: "chat", id: call, messages, maxTokens, temperature });
      });
    },
  };
}
