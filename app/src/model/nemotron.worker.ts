/// <reference lib="webworker" />
import { env, InterruptableStoppingCriteria, pipeline, TextStreamer, type TextGenerationPipeline } from "@huggingface/transformers";
import { installResumeCache } from "./resume.ts";
import type { FromWorker, ToWorker } from "@zireh/llm";

/**
 * NVIDIA Nemotron 3 Nano 4B, 4-bit, on the GPU through WebGPU. About 2.5 GB on first use; the
 * browser caches the files after that. Same setup as the webml-community Nemotron-3-Nano-WebGPU
 * demo, moved into a worker so the page never freezes. Reasoning is off: the privacy pipeline
 * wants short, direct (often JSON) answers.
 */
export const MODEL_ID = "onnx-community/NVIDIA-Nemotron-3-Nano-4B-BF16-ONNX";

const send = (message: FromWorker) => postMessage(message);
const stop = new InterruptableStoppingCriteria();
let generator: Promise<TextGenerationPipeline> | undefined;

const load = () =>
  (generator ??= (async () => {
    await installResumeCache(env);
    let weights = false;
    return pipeline("text-generation", MODEL_ID, {
      dtype: "q4",
      device: "webgpu",
      progress_callback: (p: { status: string; file?: string; progress?: number }) => {
        if (p.status === "initiate" && p.file?.includes(".onnx")) weights = true;
        if (p.status === "progress_total" && typeof p.progress === "number") {
          send({ type: "progress", percent: p.progress, phase: p.progress >= 100 && weights ? "start" : "download" });
        }
        if (p.status === "ready") send({ type: "progress", percent: 100, phase: "start" });
      },
    });
  })().catch((err: unknown) => {
    generator = undefined; // let the next load try again
    throw err;
  }) as Promise<TextGenerationPipeline>);

self.onmessage = async ({ data }: MessageEvent<ToWorker>) => {
  if (data.type === "interrupt") return stop.interrupt();
  if (data.type === "load") {
    try {
      await load();
      send({ type: "ready" });
    } catch (err) {
      send({ type: "error", message: `Couldn't start the on-device model: ${(err as Error).message}` });
    }
    return;
  }
  try {
    const generate = await load();
    stop.reset();
    let completionTokens = 0;
    const streamer = new TextStreamer(generate.tokenizer, { skip_prompt: true, skip_special_tokens: true, token_callback_function: () => void completionTokens++ });
    const output = (await generate(data.messages as { role: string; content: string }[], {
      max_new_tokens: data.maxTokens,
      do_sample: data.temperature > 0,
      ...(data.temperature > 0 ? { temperature: data.temperature, top_p: 0.95 } : {}),
      streamer,
      stopping_criteria: stop,
      tokenizer_encode_kwargs: { enable_thinking: false },
    } as Record<string, unknown>)) as { generated_text: { role: string; content: string }[] }[];
    const text = output[0]?.generated_text.at(-1)?.content ?? "";
    send({ type: "done", id: data.id, text, promptTokens: 0, completionTokens });
  } catch (err) {
    send({ type: "error", id: data.id, message: (err as Error).message });
  }
};
