import { Dialog } from "./Dialog.tsx";

const SEES: [string, string, string, string, string][] = [
  ["Your IP address", "✓", "–", "–", "–"],
  ["Names, places, quotes", "✓", "–", "–", "–"],
  ["Your case files and team", "✓", "–", "ciphertext", "–"],
  ["General questions (no names)", "✓", "✓", "–", "✓"],
  ["Which questions are decoys", "✓", "–", "–", "–"],
  ["Which questions belong together", "✓", "–", "–", "–"],
  ["Who paid", "✓", "–", "–", "–"],
];

const STEPS: [string, string][] = [
  ["Hide", "A Nemotron model on this computer finds names, places, IDs and quotes and swaps them for vague descriptions."],
  ["Rewrite and split", "Your task becomes general questions. Private and Paranoid split it so no single question tells the story."],
  ["Check for leaks", "The local model plays the provider and asks what it could infer. Risky questions are rewritten or held back."],
  ["Add decoys", "Ordinary questions on unrelated topics go out alongside the real ones."],
  ["Send separately", "Each request takes its own Tor circuit to the relay's onion address and pays with its own anonymous coins."],
  ["Put it back together", "Decoy answers are discarded. The real answers are combined here and the names are restored."],
];

/** Plain explanation of the privacy model, reachable from anywhere. */
export function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="How Zireh protects you" onClose={onClose}>
      <ol className="how-steps">
        {STEPS.map(([title, text]) => (
          <li key={title}>
            <strong>{title}.</strong> {text}
          </li>
        ))}
      </ol>
      <table className="sees">
        <caption className="level-note">Who can see what</caption>
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col">You</th>
            <th scope="col">Relay</th>
            <th scope="col">Sync host</th>
            <th scope="col">AI provider</th>
          </tr>
        </thead>
        <tbody>
          {SEES.map(([what, ...cells]) => (
            <tr key={what}>
              <th scope="row">{what}</th>
              {cells.map((c, i) => (
                <td key={i} className={c === "✓" ? "yes" : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="level-note">
        Topic still leaks: the provider can tell someone asked about newsroom safety, not who or where. The Privacy log shows exactly what
        left this computer.
      </p>
      <div className="dialog-foot">
        <button className="btn primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </Dialog>
  );
}
