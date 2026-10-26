import type { Rating } from "../../api/types";
import { Thumb } from "./icons";

interface Props {
  rating: Rating | null;
  onRate(rating: Rating): void;
}

/** Thumbs up or down on a finished answer. */
export function Feedback({ rating, onRate }: Props) {
  return (
    <div className="tx-feedback" role="group" aria-label="Rate this answer">
      <button
        type="button"
        className="tx-feedback__button"
        aria-pressed={rating === "up"}
        aria-label="Good answer"
        title="Good answer"
        onClick={() => onRate("up")}
      >
        <Thumb />
      </button>
      <button
        type="button"
        className="tx-feedback__button"
        aria-pressed={rating === "down"}
        aria-label="Bad answer"
        title="Bad answer"
        onClick={() => onRate("down")}
      >
        <Thumb down />
      </button>
    </div>
  );
}
