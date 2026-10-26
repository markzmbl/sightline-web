import { useState } from "react";

export type Theme = "system" | "dark" | "light";

const KEY = "sightline.theme";
const ORDER: Theme[] = ["system", "dark", "light"];

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return ORDER.includes(stored as Theme) ? (stored as Theme) : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be blocked; the choice then lasts for this page only.
  }
}

/** The theme choice and a function that steps it: system → dark → light. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState(readTheme);
  const next = () => {
    const following = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "system";
    applyTheme(following);
    setTheme(following);
  };
  return [theme, next];
}
