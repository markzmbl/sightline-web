import type { Cell, Column, Result } from "../../api/types";
import { counted, formatBySpecifier, formatCount, formatNumber } from "./format";

const MAX_ROWS = 100;

/** What the block needs of a result: a run's Result or one step's rows have it alike. */
type Rows = Pick<Result, "columns" | "rows" | "row_count" | "truncated">;

/** Whether the label already names the unit, as "kWh per 1,000 good units" does kWh. */
const namesUnit = (column: Column): boolean =>
  column.unit !== null && column.label.toLowerCase().includes(column.unit.toLowerCase());

/**
 * The first rows of the result under the columns' labels, each value in its column's
 * format, measures right-aligned, with how many rows there are.
 */
export function RowsBlock({ result }: { result: Rows }) {
  const shown = result.rows.slice(0, MAX_ROWS);
  // A measure aligns right; a column with no role does when its first non-null cell is a number.
  const right = result.columns.map((column, index) => {
    if (column.role !== null) return column.role === "measure";
    const first = result.rows.find((row) => row[index] !== null && row[index] !== undefined)?.[index];
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
                    className={right[index] ? "tx-rows__num" : undefined}
                    title={column.description ?? column.name}
                  >
                    {column.label || column.name}
                    {column.unit && !namesUnit(column) && <span className="tx-rows__unit"> ({column.unit})</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {result.columns.map((column, index) => (
                    <td key={index} className={right[index] ? "tx-rows__num" : undefined}>
                      <CellText cell={row[index] ?? null} format={column.format} />
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

function CellText({ cell, format }: { cell: Cell; format: string | null }) {
  if (cell === null) return <span className="tx-rows__null">–</span>;
  if (typeof cell === "number") return <>{format ? formatBySpecifier(cell, format) : formatNumber(cell)}</>;
  return <>{String(cell)}</>;
}
