// Line icons for the shell, drawn on a 16px grid in currentColor.

const STROKE = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** A window with its left panel marked: opens or closes the sidebar. */
export function PanelIcon() {
  return (
    <svg {...STROKE}>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.2" />
      <path d="M6 2.6v10.8" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...STROKE}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg {...STROKE}>
      <circle cx="7" cy="7" r="4.4" />
      <path d="m10.3 10.3 3.3 3.3" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg {...STROKE}>
      <path d="m4.5 6.2 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

/** A ticked box: the key user's review of what sightline proposes. */
export function ReviewIcon() {
  return (
    <svg {...STROKE}>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" />
      <path d="m5.3 8.1 1.9 1.9 3.6-3.8" />
    </svg>
  );
}
