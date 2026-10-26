import { describe, expect, it } from "vitest";
import {
  BRAKE_MS,
  CRUISE,
  CRUISE_MS,
  QUARTER,
  REST,
  SPIN_UP_MS,
  advance,
  cruiseMs,
  pose,
  settle,
  settleRate,
  type Spin,
} from "../src/components/working/spin";

const FRAME = 16;
// Speed may change by no more than this from one frame to the next: no visible jolt.
const SMOOTH = CRUISE * 0.05;

/** Runs the spin frame by frame, recording its pose after each frame. */
function run(from: Spin, ms: number, moving: boolean) {
  let spin = from;
  const speeds: number[] = [];
  const angles: number[] = [];
  for (let t = 0; t < ms; t += FRAME) {
    spin = advance(spin, FRAME, moving);
    speeds.push(pose(spin).speed);
    angles.push(pose(spin).angle);
  }
  return { spin, speeds, angles };
}

function largestStep(values: number[]): number {
  let largest = 0;
  for (let i = 1; i < values.length; i++) largest = Math.max(largest, Math.abs(values[i]! - values[i - 1]!));
  return largest;
}

/** Stops a spin and runs it until it rests, checking the way down is smooth and ends on the logo. */
function expectSmoothStop(spin: Spin) {
  const start = pose(spin);
  const { spin: end, speeds, angles } = run(spin, 3000, false);
  expect(end).toBe(REST);
  expect(largestStep([start.speed, ...speeds])).toBeLessThan(SMOOTH);
  expect(Math.max(...speeds)).toBeLessThanOrEqual(CRUISE * 1.07);
  for (const speed of speeds) expect(speed).toBeGreaterThanOrEqual(0); // never turns back
  // The last pose before rest is a whole number of quarter turns from the logo.
  const moving = angles.filter((_, i) => speeds[i]! > 0);
  const turns = (moving[moving.length - 1] ?? 0) / QUARTER;
  expect(Math.abs(turns - Math.round(turns))).toBeLessThan(0.001);
}

describe("the cube's spin", () => {
  it("speeds up smoothly from rest to full speed", () => {
    const { speeds } = run(REST, SPIN_UP_MS + 200, true);
    expect(speeds[0]).toBe(0);
    expect(speeds.at(-1)).toBeCloseTo(CRUISE);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(CRUISE + 1e-12);
    expect(largestStep(speeds)).toBeLessThan(SMOOTH);
  });

  it("then turns at one steady speed, with no pauses", () => {
    const { spin } = run(REST, SPIN_UP_MS, true);
    const { speeds } = run(spin, 5000, true);
    for (const speed of speeds) expect(speed).toBeCloseTo(CRUISE, 10);
    expect(CRUISE * CRUISE_MS).toBeCloseTo(QUARTER);
  });

  it("comes to rest on the logo with no jump in speed, wherever it is in its turn", () => {
    for (let workMs = SPIN_UP_MS; workMs < SPIN_UP_MS + CRUISE_MS; workMs += 37) {
      expectSmoothStop(run(REST, workMs, true).spin);
    }
  });

  it("stopped right after starting, glides on to the logo", () => {
    for (const workMs of [16, 48, 96]) expectSmoothStop(run(REST, workMs, true).spin);
  });

  it("stops within a quarter turn and a brake", () => {
    const { spin } = run(REST, SPIN_UP_MS + 100, true);
    const { spin: end } = run(spin, CRUISE_MS + BRAKE_MS + FRAME, false);
    expect(end).toBe(REST);
  });

  it("picks up again mid-brake from the speed it has", () => {
    const { spin: turning } = run(REST, SPIN_UP_MS + 200, true);
    const stopping = advance(turning, FRAME, false);
    if (stopping.mode !== "stop") throw new Error("expected a stop");
    const { spin: braking, speeds: slowing } = run(stopping, cruiseMs(stopping) + BRAKE_MS / 2, false);
    expect(braking.mode).toBe("stop");
    expect(slowing.at(-1)!).toBeLessThan(CRUISE * 0.9);
    const { speeds } = run(braking, SPIN_UP_MS + 100, true);
    expect(largestStep([slowing.at(-1)!, ...speeds])).toBeLessThan(SMOOTH);
    expect(speeds.at(-1)).toBeCloseTo(CRUISE);
  });

  it("settles from rest to rest, or brakes from speed, without turning back", () => {
    for (const k of [0, 0.5, 1, 2]) {
      expect(settle(0, k)).toBe(0);
      expect(settle(1, k)).toBeCloseTo(1, 12);
      expect(settleRate(0, k)).toBe(k);
      expect(settleRate(1, k)).toBeCloseTo(0, 12);
      for (let s = 0; s <= 1; s += 0.01) expect(settleRate(s, k)).toBeGreaterThanOrEqual(-1e-12);
    }
    expect(settle(0.5, 0)).toBeCloseTo(0.5); // the glide is symmetric
  });
});
