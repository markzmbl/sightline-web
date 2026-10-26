import type { Cell, Result } from "../../api/types";
import { counted, formatCount, formatNumber } from "./format";

const MAX_ROWS = 100;

/** The first rows of the result, numbers right-aligned, with how many there are. */
export function RowsBlock({ result }: { result: Result }) {
  const shown = result.rows.slice(0, MAX_ROWS);
  // A column is numeric when its first non-null cell is a number.
  const numeric = result.columns.map((_, column) => {
    const first = result.rows.find((row) => row[column] !== null && row[column] !== undefined)?.[column];
    return typeof first === "number";
  });
  const caption =
    shown.length < result.row_count
      ? `Showing ${formatCount(shown.length)} of ${counted(result.row_count, "row")}`
      : counted(result.row_count, "row");

  return (
    <div className="tx-rows">
      {result.columns.length > 0 && (
        <div className="tx-rows__scroll">
          <table aria-label="Result rows">
            <thead>
              <tr>
                {result.columns.map((column, index) => (
                  <th
                    key={`${index}:${column.name}`}
                    scope="col"
                    className={numeric[index] ? "tx-rows__num" : undefined}
                    title={column.type ?? undefined}
                  >
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {result.columns.map((_, index) => (
                    <td key={index} className={numeric[index] ? "tx-rows__num" : undefined}>
                      <CellText cell={row[index] ?? null} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tx-rows__caption">
        {caption}
        {result.truncated && " (truncated)"}
      </p>
    </div>
  );
}

function CellText({ cell }: { cell: Cell }) {
  if (cell === null) return <span className="tx-rows__null">–</span>;
  if (typeof cell === "number") return <>{formatNumber(cell)}</>;
  return <>{String(cell)}</>;
}
