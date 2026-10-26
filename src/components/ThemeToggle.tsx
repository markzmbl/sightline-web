import { useTheme, type Theme } from "../theme";

const NEXT: Record<Theme, Theme> = { system: "dark", dark: "light", light: "system" };

/** Steps the theme system → dark → light; the icon shows the current choice. */
export function ThemeToggle() {
  const [theme, next] = useTheme();
  return (
    <button
      type="button"
      className="icon-button"
      onClick={next}
      aria-label={`Theme: ${theme}`}
      title={`Theme: ${theme} (switch to ${NEXT[theme]})`}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  const common = {
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
  if (theme === "dark") {
    return (
      <svg {...common}>
        <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
      </svg>
    );
  }
  if (theme === "light") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="2.8" />
        <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 2.2v11.6A5.8 5.8 0 0 0 8 2.2Z" fill="currentColor" />
    </svg>
  );
}
