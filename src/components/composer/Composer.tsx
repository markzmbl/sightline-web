import { useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from "react";
import "./composer.css";

interface Props {
  placeholder: string;
  /** A run is on its way: with the box empty, the action button stops it. */
  working?: boolean;
  disabled?: boolean;
  /** Gets the trimmed text. A returned promise keeps the text until it resolves, and keeps it if it rejects. */
  onSubmit(text: string): void | Promise<unknown>;
  onStop?(): void;
  autoFocus?: boolean;
  /** The text box's accessible name; the placeholder is not one. */
  label?: string;
  /** The text box, for a page that moves focus to it. */
  ref?: Ref<HTMLTextAreaElement>;
}

/** The box at the foot of the chat: a question, or a revision of it, typed as a prompt. */
export function Composer({ placeholder, working = false, disabled = false, onSubmit, onStop, autoFocus, label, ref }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => input.current!, []); // the box is mounted by the time the handle is made
  const empty = text.trim() === "";
  const canSend = !empty && !disabled && !sending;
  const showStop = working && empty && onStop !== undefined;

  // Grow with the text; the CSS max-height turns the rest into scrolling.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  function submit() {
    if (!canSend) return;
    const sent = text;
    const result = onSubmit(sent.trim());
    // Clear only what was sent: text typed while the promise ran stays.
    const clear = () => setText((current) => (current === sent ? "" : current));
    if (!isPromise(result)) {
      clear();
      return;
    }
    setSending(true);
    result.then(clear, () => undefined).finally(() => setSending(false));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // An IME is composing: Enter picks the candidate, it does not send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  }

  function onFormSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  return (
    <form className="composer" onSubmit={onFormSubmit}>
      <div className={`composer__box${disabled ? " composer__box--disabled" : ""}`}>
        <textarea
          ref={input}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={label ?? "Question"}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {showStop ? (
          <button type="button" className="composer__action composer__action--stop" aria-label="Stop" title="Stop" onClick={onStop}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button type="submit" className="composer__action" aria-label="Send" title="Send" disabled={!canSend}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <p className="composer__hint">Enter to send · Shift+Enter for a new line</p>
    </form>
  );
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as Promise<unknown> | undefined)?.then === "function";
}
