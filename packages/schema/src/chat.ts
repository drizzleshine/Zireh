import { z } from "zod";

/** OpenAI-compatible chat shapes: shared by the local model, the relay and Token Factory. */

export const ChatRole = z.enum(["system", "user", "assistant"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatRequest = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  max_tokens: z.number().int().positive().max(32_768),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const Usage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  /** Hidden reasoning tokens included in completion_tokens (reasoning models bill these). */
  reasoning_tokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export interface ChatResult {
  readonly content: string;
  readonly usage: Usage;
  readonly model: string;
}
