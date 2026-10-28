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

let model: WorkerModel | undefined;

/** The one on-device model for this tab. Nothing downloads until `load` or the first `chat`. */
export function localModel(): WorkerModel {
  model ??= workerModel(
    new Worker(new URL("./nemotron.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
    "nemotron-3-nano-4b (on this device)",
  );
  return model;
}
