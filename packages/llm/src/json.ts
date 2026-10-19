import type { ChatMessage } from "@zireh/schema";
import type { z } from "zod";
import type { ChatModel, ChatOptions } from "./model.ts";

/** Remove reasoning blocks and code fences that small local models like to add. */
export function stripModelNoise(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "") // unterminated opening tag cut off by the template
    .replace(/```(?:json)?/gi, "")
    .trim();
}

/** First balanced JSON object or array in the text, or undefined. */
export function extractJson(text: string): string | undefined {
  const clean = stripModelNoise(text);
  const start = clean.search(/[[{]/);
  if (start < 0) return undefined;
  const open = clean[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return clean.slice(start, i + 1);
  }
  return undefined;
}

export class JsonReplyError extends Error {
  constructor(
    message: string,
    readonly reply: string,
  ) {
    super(message);
    this.name = "JsonReplyError";
  }
}

/**
 * Ask for JSON matching `schema`. On a malformed reply, retries once and tells the model what
 * was wrong. Callers must treat a thrown JsonReplyError as "fail closed".
 */
export async function chatJson<S extends z.ZodType>(
  model: ChatModel,
  messages: readonly ChatMessage[],
  schema: S,
  options: ChatOptions,
  retries = 1,
): Promise<z.infer<S>> {
  let convo: ChatMessage[] = [...messages];
  let lastReply = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { content } = await model.chat(convo, options);
    lastReply = content;
    const raw = extractJson(content);
    let problem: string;
    if (raw === undefined) problem = "The reply contained no JSON.";
    else {
      try {
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
        problem = `The JSON did not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      } catch {
        problem = "The reply was not valid JSON.";
      }
    }
    convo = [
      ...convo,
      { role: "assistant", content },
      { role: "user", content: `${problem} Reply again with only the corrected JSON.` },
    ];
  }
  throw new JsonReplyError("model did not return valid JSON", lastReply);
}
