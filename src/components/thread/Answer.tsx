import { useId, type CSSProperties } from "react";
import type { Result, Storyline, Support } from "../../api/types";
import { ChartBlock } from "./ChartBlock";

/** A small chart's width below which it needs a row of its own, when the chart does not say. */
const MIN_WIDTH = 260;

/**
 * The answer. With a storyline: its top as the heading, said once (the main chart is
 * drawn without the title it repeats), the main chart, then the key line, each point
 * followed by the small charts that show it. Without one: the chart, then the findings.
 */
export function Answer({ result }: { result: Result }) {
  const { storyline, chart } = result;
  if (storyline) return <Story result={result} storyline={storyline} />;
  return (
    <>
      {chart && <ChartBlock chart={chart} />}
      {result.findings.length > 0 && (
        <ul className="tx-findings">
          {result.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Story({ result, storyline }: { result: Result; storyline: Storyline }) {
  const topId = useId();
  const points = new Set(storyline.key_line.map((point) => point.id));
  // A support whose point the key line does not carry shows with those that have none.
  const loose = result.supports.filter((support) => support.point === null || !points.has(support.point));
  return (
    <section className="tx-answer" aria-labelledby={topId}>
      <h3 id={topId} className="tx-answer__top">
        {storyline.top}
      </h3>
      {result.chart && <ChartBlock chart={result.chart} untitled />}
      {storyline.key_line.length > 0 && (
        <ul className="tx-keyline">
          {storyline.key_line.map((point) => (
            <li key={point.id} className="tx-keyline__point">
              <p className="tx-keyline__text">{point.text}</p>
              <Supports supports={result.supports.filter((support) => support.point === point.id)} />
            </li>
          ))}
        </ul>
      )}
      <Supports supports={loose} />
    </section>
  );
}

/**
 * A point's supports as far as they draw anything beside the main chart: small charts
 * in a grid, two to a row where both fit their minimum width, one on a phone; a dropped
 * chart as the note on why it was left out. The lead (drawn main) and a support with
 * no chart add nothing here.
 */
function Supports({ supports }: { supports: Support[] }) {
  const small = supports.filter((support) => support.drawn === "small" && support.chart !== null);
  const dropped = supports.filter((support) => support.drawn === "dropped");
  if (small.length === 0 && dropped.length === 0) return null;
  const min = Math.max(...small.map((support) => support.chart?.min_width ?? MIN_WIDTH));
  return (
    <>
      {small.length > 0 && (
        <div className="tx-smalls" style={{ "--tx-small-min": `${min}px` } as CSSProperties}>
          {small.map((support) =>
            support.chart ? (
              <figure key={support.id} className="tx-small">
                <ChartBlock chart={support.chart} small />
                <figcaption className="tx-small__caption">{support.text}</figcaption>
              </figure>
            ) : null,
          )}
        </div>
      )}
      {dropped.map((support) => (
        <p key={support.id} className="tx-dropped">
          {support.note ?? support.text}
        </p>
      ))}
    </>
  );
}

/** Every caveat of the answer, the only place they are said: never in a chart, the key line or the restatement. */
export function Notes({ notes }: { notes: string[] }) {
  const titleId = useId();
  if (notes.length === 0) return null;
  return (
    <section className="tx-notes" aria-labelledby={titleId}>
      <h4 id={titleId} className="tx-notes__title">
        Notes
      </h4>
      <ul className="tx-notes__list">
        {notes.map((note, index) => (
          <li key={`${index}:${note}`}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

/** validate's doubts about the answer, quietly: a warn or fail verdict, with its concerns. */
export function Concerns({ result }: { result: Result }) {
  const titleId = useId();
  if (result.verdict === "pass") return null;
  return (
    <div className={`tx-concerns tx-concerns--${result.verdict}`} role="note" aria-labelledby={titleId}>
      <p id={titleId} className="tx-concerns__title">
        sightline is not sure this answers the question
      </p>
      {result.concerns.length > 0 && (
        <ul className="tx-concerns__list">
          {result.concerns.map((concern, index) => (
            <li key={`${index}:${concern}`}>{concern}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
