import { useId, useRef, useState } from "react";
import { addWord, placeOf, rowLocales, type Collision, type Words } from "./draft";
import { localeName } from "./format";
import { CrossIcon } from "./icons";

interface Props {
  words: Words;
  /** Words the last save could not take, shown beside their chips. */
  collisions: readonly Collision[];
  disabled: boolean;
  onChange(locale: string, list: string[]): void;
}

/** The words that name the term, one row per locale: chips to remove, a box to add one (Enter). */
export function WordsEditor({ words, collisions, disabled, onChange }: Props) {
  // English and German always have a row, so an entry can get its first words in either.
  return (
    <div className="rv-words">
      {rowLocales(words).map((locale) => (
        <LocaleRow
          key={locale}
          locale={locale}
          list={words[locale] ?? []}
          collisions={collisions.filter((collision) => collision.locale === locale)}
          disabled={disabled}
          onChange={(list) => onChange(locale, list)}
        />
      ))}
    </div>
  );
}

interface RowProps {
  locale: string;
  list: string[];
  collisions: Collision[];
  disabled: boolean;
  onChange(list: string[]): void;
}

function LocaleRow({ locale, list, collisions, disabled, onChange }: RowProps) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const name = localeName(locale);
  // A collision whose word was removed since has nothing left to point at.
  const clashAt = new Map<number, Collision>();
  for (const collision of collisions) {
    const at = placeOf(collision, list);
    if (at >= 0 && !clashAt.has(at)) clashAt.set(at, collision);
  }

  const add = () => {
    const next = addWord(list, text);
    if (next !== list) onChange([...next]);
    setText("");
  };

  const remove = (index: number) => {
    onChange(list.filter((_, at) => at !== index));
    // The chip's button goes away with it; the box to add a word is the next place to be.
    input.current?.focus();
  };

  return (
    <div className="rv-words__row" role="group" aria-labelledby={`${id}-locale`}>
      <span id={`${id}-locale`} className="rv-words__locale" title={name}>
        <span aria-hidden="true">{locale}</span>
        <span className="sr-only">{`Words in ${name}`}</span>
      </span>
      <ul className="rv-words__chips">
        {list.map((word, index) => {
          const clash = clashAt.get(index);
          const messageId = `${id}-clash-${index}`;
          return (
            <li key={`${index}:${word}`} className="rv-words__item">
              <span className={clash ? "rv-word rv-word--clash" : "rv-word"} data-word={word}>
                <span className="rv-word__text">{word}</span>
                <button
                  type="button"
                  className="rv-word__remove"
                  aria-label={`Remove “${word}”`}
                  title="Remove"
                  aria-describedby={clash ? messageId : undefined}
                  disabled={disabled}
                  onClick={() => remove(index)}
                >
                  <CrossIcon />
                </button>
              </span>
              {clash && (
                <span id={messageId} className="rv-words__clash">
                  “{clash.word}” already names {clash.collidesWith}.
                </span>
              )}
            </li>
          );
        })}
        <li className="rv-words__add">
          <input
            ref={input}
            className="rv-words__input"
            value={text}
            placeholder="Add a word"
            aria-label={`Add a word in ${name}`}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              add();
            }}
          />
        </li>
      </ul>
    </div>
  );
}
