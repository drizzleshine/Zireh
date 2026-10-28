import type { ChatMessage, ChatResult, FetchLike } from "@zireh/schema";

export type { FetchLike };

export interface ChatOptions {
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** The one interface every model sits behind: the on-device Nemotron Nano, an OpenAI-compatible endpoint, or a test double. */
export interface ChatModel {
  readonly id: string;
  chat(messages: readonly ChatMessage[], options: ChatOptions): Promise<ChatResult>;
}

/** Cancellation applies to every local stage, including providers that finish after abort. */
export function abortableModel(model: ChatModel, signal?: AbortSignal): ChatModel {
  if (!signal) return model;
  return {
    id: model.id,
    async chat(messages, options) {
      signal.throwIfAborted();
      const result = await model.chat(messages, { ...options, signal });
      signal.throwIfAborted();
      return result;
    },
  };
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/** Deterministic test double: the handler sees the messages and returns the reply text. */
export function scriptedModel(
  handler: (messages: readonly ChatMessage[]) => string | Promise<string>,
  id = "scripted",
): ChatModel & { readonly calls: (readonly ChatMessage[])[] } {
  const calls: (readonly ChatMessage[])[] = [];
  return {
    id,
    calls,
    async chat(messages) {
      calls.push(messages);
      const content = await handler(messages);
      const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
      return {
        content,
        model: id,
        usage: { prompt_tokens: messages.reduce((n, m) => n + words(m.content), 0), completion_tokens: words(content) },
      };
    },
  };
}
