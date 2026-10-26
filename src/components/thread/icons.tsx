// Small inline icons for the transcript. They take their colour from the text.

/** The fold chevron; it turns down when its button is aria-expanded (thread.css). */
export function Chevron() {
  return (
    <svg className="tx-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A thumb up, or turned over, a thumb down. */
export function Thumb({ down = false }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <g
        transform={down ? "rotate(180 8 8)" : undefined}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 7h2.5v6.7H2z" />
        <path d="M4.5 7.5 7.2 2.6c.95-.1 1.8.65 1.65 1.7L8.5 6.5h4.1a1.3 1.3 0 0 1 1.27 1.6l-1.05 4.6a1.3 1.3 0 0 1-1.27 1H4.5" />
      </g>
    </svg>
  );
}
