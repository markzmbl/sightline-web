// A key user's unsaved edits to an entry (its label and its words per locale), carried
// over to a newer version when one arrives, and the word collisions a save can meet.
import type { ErrorItem, RegistryEntry } from "../../api/types";

export type Words = Record<string, string[]>;

export interface Fields {
  label: string;
  words: Words;
}

export interface Draft {
  /** The version the edits apply to: the one shown, and the one a save sends. */
  version: number;
  /** The entry's fields at that version, to tell an edit from what was there. */
  base: Fields;
  fields: Fields;
}

const fieldsOf = (entry: RegistryEntry): Fields => ({ label: entry.label, words: entry.words });

export function startDraft(entry: RegistryEntry): Draft {
  const fields = fieldsOf(entry);
  return { version: entry.version, base: fields, fields };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((word, index) => word === b[index]);

/** The locales of one or more word sets, English first, then in the order they come. */
export function localesOf(...sets: Words[]): string[] {
  const locales = new Set<string>();
  for (const set of sets) for (const locale of Object.keys(set)) locales.add(locale);
  return [...locales].sort((a, b) => Number(b === "en") - Number(a === "en"));
}

export function sameWords(a: Words, b: Words): boolean {
  return localesOf(a, b).every((locale) => sameList(a[locale] ?? [], b[locale] ?? []));
}

// A label is saved trimmed: spaces around it are no edit.
const sameLabel = (a: string, b: string): boolean => a.trim() === b.trim();

export function isDirty(draft: Draft): boolean {
  return !sameLabel(draft.fields.label, draft.base.label) || !sameWords(draft.fields.words, draft.base.words);
}

/**
 * Carries the edits over to a newer version of the entry. An edit stays where the
 * newer version left that field (the label, or one locale's words) as it was; where
 * both changed it differently, the newer version wins and `dropped` names the field:
 * "label", or the locale whose words it was.
 */
export function rebase(draft: Draft, entry: RegistryEntry): { draft: Draft; dropped: string[] } {
  const latest = fieldsOf(entry);
  const dropped: string[] = [];
  const merge = <T>(field: string, mine: T, base: T, theirs: T, same: (a: T, b: T) => boolean): T => {
    if (same(mine, base) || same(mine, theirs)) return theirs;
    if (same(theirs, base)) return mine;
    dropped.push(field);
    return theirs;
  };

  const label = merge("label", draft.fields.label, draft.base.label, latest.label, sameLabel);
  const words: Words = {};
  for (const locale of localesOf(latest.words, draft.fields.words)) {
    const kept = merge(
      locale,
      draft.fields.words[locale] ?? [],
      draft.base.words[locale] ?? [],
      latest.words[locale] ?? [],
      sameList,
    );
    if (kept.length > 0 || locale in latest.words) words[locale] = kept;
  }
  return { draft: { version: entry.version, base: latest, fields: { label, words } }, dropped };
}

/** The words a save sends: every locale the entry had (one emptied too), and the new ones given words. */
export function wordsToSave(draft: Draft): Words {
  return Object.fromEntries(
    Object.entries(draft.fields.words).filter(([locale, list]) => list.length > 0 || locale in draft.base.words),
  );
}

/** The languages that always get a row of words, whether the entry has any in them or not. */
export const LOCALES: readonly string[] = ["en", "de"];

/** The rows of words to show: the usual languages first, then any other the entry has. */
export function rowLocales(words: Words): string[] {
  return localesOf(Object.fromEntries(LOCALES.map((locale) => [locale, []])), words);
}

/** The list with the word added at its end; unchanged for a blank word or one it has (ignoring case). */
export function addWord(list: readonly string[], word: string): readonly string[] {
  const text = word.trim().replace(/\s+/g, " ");
  if (!text) return list;
  const needle = text.toLocaleLowerCase();
  return list.some((existing) => existing.toLocaleLowerCase() === needle) ? list : [...list, text];
}

/** A word a save could not take: it already names another term. */
export interface Collision {
  locale: string;
  /** The word's place in the list that was sent, when the error says. */
  index: number | null;
  word: string;
  collidesWith: string;
}

/**
 * The word_collision items of a 422. `loc` runs [..., "words", locale, index], and
 * ctx {word, collides_with}; a missing word is read from the list that was sent.
 */
export function collisionsOf(errors: readonly ErrorItem[], sent: Words): Collision[] {
  return errors.flatMap((item): Collision[] => {
    if (item.type !== "word_collision") return [];
    const at = item.loc.lastIndexOf("words");
    const locale = at >= 0 ? item.loc[at + 1] : undefined;
    if (typeof locale !== "string") return [];
    const place = item.loc[at + 2];
    const index =
      typeof place === "number" ? place : typeof place === "string" && /^\d+$/.test(place) ? Number(place) : null;
    const ctx = item.ctx ?? {};
    const word = typeof ctx.word === "string" ? ctx.word : index === null ? undefined : sent[locale]?.[index];
    if (!word) return [];
    const other = ctx.collides_with;
    const collidesWith = typeof other === "string" && other ? other : "another term";
    return [{ locale, index, word, collidesWith }];
  });
}

/** Where a collision's word sits in a locale's list now: at its old place if still there, else wherever it went. */
export function placeOf(collision: Collision, list: readonly string[]): number {
  if (collision.index !== null && list[collision.index] === collision.word) return collision.index;
  return list.indexOf(collision.word);
}
