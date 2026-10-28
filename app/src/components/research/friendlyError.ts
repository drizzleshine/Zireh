/** Pipeline errors are written for developers; say what happened and what to do. */
export function friendlyError(message: string): string {
  if (/no real piece was answered|fetch failed|unreachable/i.test(message)) return "No answer came back: the AI couldn't be reached. Try again in a moment.";
  const level = /^(Local only|Private|Paranoid|Local)\b.*needs on-device AI/i.exec(message);
  if (level) return `${level[1] === "Local" ? "Local only" : level[1]} needs on-device AI, which is off. Ask again to use Standard.`;
  if (/insufficient|not enough|balance/i.test(message)) return "Not enough balance for this question. Add money and ask again.";
  return message;
}
