// Which fixture answers a question: the best word overlap (Jaccard) wins.
import type { Fixture } from "./fixture.ts";

const STOPWORDS = new Set(
  (
    "a an and are as at be been by can could did do does each every for from had has have how i in is it its " +
    "me much my of on or our over per please show tell that the their them these this those to us was we were " +
    "what when where which who why will with would you your"
  ).split(" "),
);

/** Below this overlap a question matches nothing, and the fixtures take turns. */
export const MIN_SCORE = 0.15;

export function words(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface Match {
  fixture: Fixture;
  score: number;
}

/** The fixture whose question overlaps `text` most; `avoid` loses unless it is the only one. */
export function bestMatch(fixtures: readonly Fixture[], text: string, avoid?: string): Match | null {
  const asked = words(text);
  const pool = fixtures.some((f) => f.slug !== avoid) ? fixtures.filter((f) => f.slug !== avoid) : fixtures;
  let best: Match | null = null;
  for (const fixture of pool) {
    const score = jaccard(asked, words(fixture.question));
    if (!best || score > best.score) best = { fixture, score };
  }
  return best;
}
