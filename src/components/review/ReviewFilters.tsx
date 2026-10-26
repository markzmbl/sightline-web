import { useRef, type KeyboardEvent } from "react";
import type { RegistryCounts, RegistryKind, RegistryStatus } from "../../api/types";
import { KIND_PLURAL, KINDS, STATUS_LABEL, STATUSES } from "./format";
import "./review.css";

/** The id of a status tab, for the panel it labels. */
export const tabId = (prefix: string, status: RegistryStatus): string => `${prefix}-tab-${status}`;

const total = (counts: RegistryCounts | undefined): number | null =>
  counts ? counts.measure + counts.default + counts.gap : null;

interface TabsProps {
  status: RegistryStatus;
  counts: RegistryCounts | undefined;
  /** Prefix for the tabs' ids. */
  idPrefix: string;
  /** The id of the panel the tabs control: the list. */
  panelId: string;
  onStatus(status: RegistryStatus): void;
}

/** Proposed (with how many wait), Approved, Rejected: the list's status filter, as tabs. */
export function StatusTabs({ status, counts, idPrefix, panelId, onStatus }: TabsProps) {
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const waiting = total(counts);

  // Arrow keys move along the tabs and select as they go; Home and End jump to the ends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = STATUSES.indexOf(status);
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % STATUSES.length
        : event.key === "ArrowLeft"
          ? (at - 1 + STATUSES.length) % STATUSES.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? STATUSES.length - 1
              : null;
    const target = next === null ? undefined : STATUSES[next];
    if (!target) return;
    event.preventDefault();
    tabs.current[target]?.focus();
    if (target !== status) onStatus(target);
  };

  return (
    <div className="rv-tabs" role="tablist" aria-label="Status" onKeyDown={onKeyDown}>
      {STATUSES.map((candidate) => {
        const selected = candidate === status;
        return (
          <button
            key={candidate}
            ref={(element) => {
              tabs.current[candidate] = element;
            }}
            id={tabId(idPrefix, candidate)}
            type="button"
            role="tab"
            className="rv-tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onStatus(candidate);
            }}
          >
            {STATUS_LABEL[candidate]}
            {candidate === "proposed" && waiting !== null && waiting > 0 && (
              <>
                {" "}
                <span className="rv-tab__count">{waiting}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface KindProps {
  kind: RegistryKind | null;
  /** Proposed entries per kind, on every tab: what waits for review. The count says so on hover and when read out. */
  counts: RegistryCounts | undefined;
  onKind(kind: RegistryKind | null): void;
}

/** All, Measures, Defaults, Gaps, each with how many are proposed: the list's kind filter. */
export function KindChips({ kind, counts, onKind }: KindProps) {
  const options: { value: RegistryKind | null; label: string; count: number | null }[] = [
    { value: null, label: "All", count: total(counts) },
    ...KINDS.map((value) => ({ value, label: KIND_PLURAL[value], count: counts ? counts[value] : null })),
  ];
  return (
    <div className="rv-kinds" role="group" aria-label="Kind">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className="pill rv-kinds__chip"
          aria-pressed={option.value === kind}
          onClick={() => {
            if (option.value !== kind) onKind(option.value);
          }}
        >
          {option.label}
          {option.count !== null && option.count > 0 && (
            <>
              {" "}
              <span className="rv-kinds__count" title={`${option.count} proposed`}>
                {option.count} <span className="sr-only">proposed</span>
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
