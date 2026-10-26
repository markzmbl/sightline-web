import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingCube } from "../src/components/working/WorkingCube";

// Frames by hand: each step runs the callbacks queued for the next frame, 16 ms on.
let queue = new Map<number, FrameRequestCallback>();
let nextId = 1;
let clock = 0;

beforeEach(() => {
  queue = new Map();
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.set(nextId, cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => queue.delete(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function frames(n: number, sample: () => void) {
  for (let i = 0; i < n; i++) {
    clock += 16;
    const due = [...queue.values()];
    queue.clear();
    act(() => due.forEach((cb) => cb(clock)));
    sample();
  }
}

/** The angle of the top face's first corner about the top's centre, in the logo's 2:1 view. */
function topAngle(svg: SVGSVGElement): number {
  const top = [...svg.querySelectorAll("path")].find((p) => p.getAttribute("fill") === "#aa9ad1");
  const m = top?.getAttribute("d")?.match(/M(-?[\d.]+) (-?[\d.]+)/);
  if (!m) throw new Error("no top face");
  return Math.atan2((Number(m[2]) - 17.92) * 2, Number(m[1]) - 32);
}

describe("WorkingCube", () => {
  it("spins at one steady speed while working, never pausing or switching axis", () => {
    const { container, rerender } = render(<WorkingCube state="working" size={96} />);
    const svg = container.querySelector("svg")!;
    frames(60, () => undefined); // past the spin-up
    const angles: number[] = [];
    frames(200, () => {
      angles.push(topAngle(svg));
      if (angles.length === 50) rerender(<WorkingCube state="working" size={96} label="Querying" />); // a re-render mid-spin, as a new stage causes
    });
    // The top is a square: a quarter turn brings it back, so steps are measured modulo one.
    const quarter = Math.PI / 2;
    const steps = angles.slice(1).map((a, i) => {
      const d = (((a - angles[i]! + quarter / 2) % quarter) + quarter) % quarter - quarter / 2;
      return Math.abs(d);
    });
    const mean = steps.reduce((sum, d) => sum + d, 0) / steps.length;
    expect(mean).toBeCloseTo((Math.PI / 2 / 900) * 16, 3); // a quarter turn every 0.9 s
    // Every frame turns it by the same amount, a stage change too (paths are rounded to 0.01).
    for (const d of steps) {
      expect(d).toBeGreaterThan(mean * 0.9);
      expect(d).toBeLessThan(mean * 1.1);
    }
  });

  it("comes to rest as the logo when the work stops", () => {
    const { container, rerender } = render(<WorkingCube state="working" size={96} />);
    frames(80, () => undefined);
    rerender(<WorkingCube state="asking" size={96} />);
    frames(150, () => undefined);
    expect(queue.size).toBe(0); // no frames asked for at rest
    const logo = render(<WorkingCube state="asking" size={96} />).container;
    const faces = (root: Element) => [...root.querySelectorAll("path")].map((p) => `${p.getAttribute("fill")} ${p.getAttribute("d")}`);
    expect(faces(container)).toEqual(faces(logo));
  });
});
