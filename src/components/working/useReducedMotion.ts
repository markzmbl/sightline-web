import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** The viewer's reduced-motion setting, unless `override` says otherwise. */
export function useReducedMotion(override?: boolean): boolean {
  const [prefers, setPrefers] = useState(() => typeof matchMedia === "function" && matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(QUERY);
    const update = () => setPrefers(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return override ?? prefers;
}
