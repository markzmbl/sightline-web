import { Link } from "react-router";
import type { Definition } from "../../api/types";
import { definitionWording } from "./words";

/** Where a registry entry is reviewed, from the thread's page (/w/:ws/t/:threadId). */
export const reviewPath = (entryId: string): string => `../../review/${encodeURIComponent(entryId)}`;

/**
 * The definitions the run used, under the restatement, which never says them itself:
 * each with its source and whether a key user approved it, and the definition in words.
 * A registry entry's name links to its review.
 */
export function Definitions({ definitions }: { definitions: Definition[] }) {
  if (definitions.length === 0) return null;
  return (
    <ul className="tx-defs" aria-label="Definitions">
      {definitions.map((definition, index) => (
        <li key={`${index}:${definition.name}`} className={`tx-defs__item tx-defs__item--${definition.status}`}>
          <p className="tx-defs__line">
            {definition.entry_id ? (
              <Link className="tx-defs__name" to={reviewPath(definition.entry_id)} relative="path">
                {definition.label}
              </Link>
            ) : (
              <span className="tx-defs__name">{definition.label}</span>
            )}
            : {definitionWording(definition)}
          </p>
          {definition.definition && <p className="tx-defs__text">{definition.definition}</p>}
        </li>
      ))}
    </ul>
  );
}
