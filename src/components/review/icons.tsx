// Line icons for the review view, on the shell's 16px grid in currentColor.

const STROKE = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

/** A small cross: removes a word. */
export function CrossIcon({ size = 10 }: { size?: number }) {
  return (
    <svg {...STROKE} width={size} height={size} strokeWidth={1.8}>
      <path d="m3.5 3.5 9 9m0-9-9 9" />
    </svg>
  );
}

/** Points back to the list, on a narrow page. */
export function BackIcon() {
  return (
    <svg {...STROKE} width={14} height={14}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}

/** A thumb up, or turned over, a thumb down: how a run that used the entry was rated. */
export function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg {...STROKE} width={14} height={14} strokeWidth={1.3}>
      <g transform={down ? "rotate(180 8 8)" : undefined}>
        <path d="M2 7h2.5v6.7H2z" />
        <path d="M4.5 7.5 7.2 2.6c.95-.1 1.8.65 1.65 1.7L8.5 6.5h4.1a1.3 1.3 0 0 1 1.27 1.6l-1.05 4.6a1.3 1.3 0 0 1-1.27 1H4.5" />
      </g>
    </svg>
  );
}
