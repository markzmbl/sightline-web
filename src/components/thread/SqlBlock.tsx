import { useEffect, useMemo, useState } from "react";
import { layoutSql, sqlLines } from "./sqlHighlight";

/** The run's SQL, laid out by clause, line-numbered and lightly highlighted. */
export function SqlBlock({ sql }: { sql: string }) {
  const text = useMemo(() => layoutSql(sql), [sql]);
  const lines = useMemo(() => sqlLines(text), [text]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard here (an insecure origin, say): the text can still be selected.
    }
  };

  return (
    <div className="tx-sql">
      <div className="tx-sql__bar">
        <span>SQL</span>
        <button type="button" className="tx-link" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="tx-sql__code">
        <code>
          {lines.map((line, index) => (
            <span key={index} className="tx-sql__line">
              <span className="tx-sql__ln" aria-hidden="true">
                {index + 1}
              </span>
              {line.map((token, at) =>
                token.kind === "plain" || token.kind === "space" ? (
                  token.text
                ) : (
                  <span key={at} className={`tx-sql__${token.kind}`}>
                    {token.text}
                  </span>
                ),
              )}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
