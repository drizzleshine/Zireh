import type { Observation } from "@zireh/schema";

/** An AI observation is stored as "Q: question\n\nanswer"; the answer is the observation. */
export const splitAi = (o: Observation) => {
  const m = /^Q: (.*)\n\n([\s\S]*)$/.exec(o.text);
  return { question: m?.[1], text: (m?.[2] ?? o.text).replace(/\s*\[A\d+\]/g, "") };
};
