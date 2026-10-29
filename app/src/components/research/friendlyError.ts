/** Pipeline errors are written for developers; say what happened and what to do. */
export function friendlyError(message: string): string {
  if (/content_policy|content management policy|content filter/i.test(message)) return "The AI provider's content filter refused this question. Nothing was charged. Try rewording it, or ask about the general topic.";
  if (/fetch failed|failed to fetch|unreachable|network/i.test(message) || /^no real piece was answered$/i.test(message)) return "No answer came back: the AI couldn't be reached. Try again in a moment.";
  const reason = /^no real piece was answered: (.*)$/is.exec(message);
  if (reason) return `No answer came back. The provider said: ${reason[1]!.replace(/^[\w.:-]+: /, "").slice(0, 200)}`;
  const level = /^(Local only|Private|Paranoid|Local)\b.*needs on-device AI/i.exec(message);
  if (level) return `${level[1] === "Local" ? "Local only" : level[1]} needs on-device AI, which is off. Ask again to use Standard.`;
  if (/insufficient|not enough|balance/i.test(message)) return "Not enough balance for this question. Add money and ask again.";
  return message;
}
