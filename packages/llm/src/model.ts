import type { ChatMessage, ChatResult, FetchLike } from "@zireh/schema";

export type { FetchLike };

export interface ChatOptions {
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** The one interface every model sits behind: local Nemotron Nano, Token Factory, or a test double. */
export interface ChatModel {
  readonly id: string;
  chat(messages: readonly ChatMessage[], options: ChatOptions): Promise<ChatResult>;
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

interface OpenAiConfig {
  readonly baseUrl: string; // e.g. http://127.0.0.1:11434/v1 or https://api.tokenfactory.nebius.com/v1
  readonly model: string;
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
}

/** Any OpenAI-compatible `/chat/completions` endpoint (Ollama, Token Factory, …). */
export function openAiCompatible(config: OpenAiConfig): ChatModel {
  const doFetch = config.fetch ?? fetch;
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  return {
    id: config.model,
    async chat(messages, { maxTokens, temperature, signal }) {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, messages, max_tokens: maxTokens, temperature }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new ModelError(`${config.model}: HTTP ${res.status} ${await res.text()}`, res.status);
      const body = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        content: body.choices?.[0]?.message?.content ?? "",
        model: body.model ?? config.model,
        usage: {
          prompt_tokens: body.usage?.prompt_tokens ?? 0,
          completion_tokens: body.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
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
