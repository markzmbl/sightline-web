import type { EntryChoice } from "../../api/types";

interface Props {
  choices: EntryChoice[];
  /** The id of the option the default chooses (RegistryEntry.chosen_option), marked in the list. */
  chosen: string | null;
}

/** What users picked on the card for a learned default: one bar per option, the counts as text. */
export function ChoiceBars({ choices, chosen }: Props) {
  const most = Math.max(1, ...choices.map((choice) => choice.count));
  const sorted = [...choices].sort((a, b) => b.count - a.count);
  return (
    <ul className="rv-bars">
      {sorted.map((choice) => (
        <li key={choice.option} className="rv-bars__row">
          <span className="rv-bars__label">
            {choice.label}
            {chosen !== null && choice.option === chosen && (
              <>
                {/* The label is a flex row, where a plain space is dropped: the separator is said, not shown. */}
                <span className="sr-only">, </span>
                <span className="rv-tag rv-bars__tag">the default</span>
              </>
            )}
          </span>
          <span className="rv-bars__track" aria-hidden="true">
            <span className="rv-bars__bar" style={{ width: `${(Math.max(0, choice.count) / most) * 100}%` }} />
          </span>
          <span className="rv-bars__count">
            {choice.count}
            <span className="sr-only">{choice.count === 1 ? " pick" : " picks"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
