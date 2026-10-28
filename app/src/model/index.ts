import { workerModel, type WorkerLike, type WorkerModel } from "@zireh/llm";

/** Why the on-device model can't run here, or undefined when it can. */
export async function unsupportedReason(): Promise<string | undefined> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return "This browser has no WebGPU. Use a recent Chrome or Edge on a computer.";
  try {
    if (!(await gpu.requestAdapter())) return "WebGPU is on, but no graphics card was offered to it.";
  } catch {
    return "WebGPU is on, but the graphics card couldn't be reached.";
  }
  return undefined;
}

const MODEL_NAME = "nemotron-3-nano-4b (on this device)";
let worker: WorkerModel | undefined;
const started = () => (worker ??= workerModel(new Worker(new URL("./nemotron.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike, MODEL_NAME));

/** The one on-device model for this tab. Nothing starts or downloads until `load` or the first `chat`. */
export const localModel = (): WorkerModel => ({
  id: MODEL_NAME,
  load: (onProgress) => started().load(onProgress),
  chat: (messages, options) => started().chat(messages, options),
});
