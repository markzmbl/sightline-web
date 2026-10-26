// A light SQL tokenizer for the SQL block: enough to colour keywords, functions,
// strings, numbers and comments, and to lay a one-line query out by clause.
// It never builds HTML; SqlBlock renders the tokens as React text.

export type TokenKind = "keyword" | "function" | "string" | "number" | "comment" | "space" | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "ORDER", "BY", "JOIN", "INNER", "LEFT", "RIGHT",
  "FULL", "OUTER", "CROSS", "NATURAL", "ON", "USING", "AS", "AND", "OR", "NOT", "IN",
  "BETWEEN", "LIMIT", "OFFSET", "HAVING", "QUALIFY", "WINDOW", "OVER", "PARTITION",
  "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "UNION", "EXCEPT", "INTERSECT", "ALL",
  "DISTINCT", "DESC", "ASC", "NULLS", "FIRST", "LAST", "LIKE", "ILIKE", "IS", "NULL",
  "TRUE", "FALSE", "DATE", "TIMESTAMP", "INTERVAL", "CAST", "FILTER", "EXISTS", "ANY",
]);

// Clauses that start a new line when a one-line query is laid out.
const CLAUSES = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "QUALIFY", "WINDOW", "LIMIT",
  "OFFSET", "UNION", "EXCEPT", "INTERSECT", "JOIN", "LEFT", "RIGHT", "INNER", "FULL", "CROSS",
]);
// Words that may come before JOIN, so "LEFT OUTER JOIN" stays on one line.
const JOIN_LEAD = new Set(["LEFT", "RIGHT", "INNER", "FULL", "CROSS", "OUTER", "NATURAL"]);
// Keywords that are also functions: LEFT(name, 3) is a call, not a join.
const KEYWORD_CALLS = new Set(["LEFT", "RIGHT"]);

const TOKEN =
  /(--[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|([A-Za-z_][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\s+)|([\s\S])/g;

export function tokenize(sql: string): Token[] {
  const raw: Token[] = [];
  for (const match of sql.matchAll(TOKEN)) {
    const [text, line, block, string, quoted, word, number, space] = match;
    if (line !== undefined || block !== undefined) raw.push({ kind: "comment", text });
    else if (string !== undefined) raw.push({ kind: "string", text });
    else if (quoted !== undefined) raw.push({ kind: "plain", text });
    else if (word !== undefined) raw.push({ kind: KEYWORDS.has(word.toUpperCase()) ? "keyword" : "plain", text });
    else if (number !== undefined) raw.push({ kind: "number", text });
    else if (space !== undefined) raw.push({ kind: "space", text });
    else raw.push({ kind: "plain", text });
  }
  // A plain word right before "(" is a function call: SUM(, date_trunc(; so are LEFT( and RIGHT(.
  return raw.map((token, index) => {
    const word =
      (token.kind === "plain" && /^[A-Za-z_]/.test(token.text)) ||
      (token.kind === "keyword" && KEYWORD_CALLS.has(token.text.toUpperCase()));
    if (!word) return token;
    return nextSolid(raw, index)?.text === "(" ? { kind: "function", text: token.text } : token;
  });
}

function nextSolid(tokens: Token[], index: number): Token | undefined {
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token && token.kind !== "space") return token;
  }
  return undefined;
}

/**
 * Breaks a one-line query before its top-level clauses. SQL that already has
 * line breaks is left as its author laid it out.
 */
export function layoutSql(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed.includes("\n")) return trimmed;
  const tokens = tokenize(trimmed);
  let out = "";
  let depth = 0;
  let previous = "";
  tokens.forEach((token) => {
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth = Math.max(0, depth - 1);
    const upper = token.text.toUpperCase();
    // A clause that opens a bracket still starts a line: WHERE (…), HAVING (…), FROM (subquery).
    // LEFT( and RIGHT( are functions by now, so they never get here.
    if (token.kind === "keyword" && depth === 0 && out && CLAUSES.has(upper)) {
      if (!(upper === "JOIN" && JOIN_LEAD.has(previous))) out = `${out.trimEnd()}\n`;
    }
    if (token.kind === "space" && out.endsWith("\n")) return;
    out += token.text;
    if (token.kind !== "space") previous = upper;
  });
  return out;
}

/** The tokens of each line; a token spanning lines (a block comment) is split. */
export function sqlLines(sql: string): Token[][] {
  let line: Token[] = [];
  const lines: Token[][] = [line];
  for (const token of tokenize(sql)) {
    token.text.split("\n").forEach((part, index) => {
      if (index > 0) {
        line = [];
        lines.push(line);
      }
      if (part) line.push({ kind: token.kind, text: part });
    });
  }
  return lines;
}
