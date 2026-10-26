// How the working cube moves: a steady turn about its vertical, like a top. It
// speeds up smoothly when work starts and, when work stops, turns on until it can
// brake onto the next quarter turn, where it is the logo again. Neither its speed
// nor its acceleration ever jumps, so it reads as one solid thing rotating.

export const QUARTER = Math.PI / 2;
/** A quarter turn at full speed; a whole turn takes four. */
export const CRUISE_MS = 900;
/** Full speed, in radians per ms. */
export const CRUISE = QUARTER / CRUISE_MS;
export const SPIN_UP_MS = 600;
export const BRAKE_MS = 700;
// Slower than this it has barely started: it glides on to the logo instead of braking.
const SLOWEST = CRUISE / 4;
// The top speed of a glide from rest to rest, as a multiple of its mean speed.
const GLIDE_PEAK = 1.875;

export type Spin =
  | { mode: "rest" }
  /** Turning, `angle` past the last logo pose; the speed eases from `from` to full over SPIN_UP_MS, `t` ms in. */
  | { mode: "turn"; angle: number; speed: number; from: number; t: number }
  /**
   * Coming to rest from `angle` at `speed`: on at that speed for `cruise` radians,
   * then settling over the last `settle` radians in `settleMs`, `t` ms in.
   */
  | { mode: "stop"; angle: number; speed: number; cruise: number; settle: number; settleMs: number; t: number };

export const REST: Spin = { mode: "rest" };

/** The spin `dt` ms later, turning on or coming to rest as `moving` says. */
export function advance(spin: Spin, dt: number, moving: boolean): Spin {
  switch (spin.mode) {
    case "rest":
      return moving ? { mode: "turn", angle: 0, speed: 0, from: 0, t: 0 } : spin;
    case "turn": {
      if (!moving) return advance(stopFrom(spin.angle, spin.speed), dt, false);
      const t = spin.t + dt;
      const speed = spin.from + (CRUISE - spin.from) * smoothstep(t / SPIN_UP_MS);
      const angle = (spin.angle + ((spin.speed + speed) / 2) * dt) % QUARTER;
      return { ...spin, angle, speed, t };
    }
    case "stop": {
      if (moving) {
        // Back to work before it came to rest: speed up again from the speed it has now.
        const now = pose(spin);
        return advance({ mode: "turn", angle: now.angle % QUARTER, speed: now.speed, from: now.speed, t: 0 }, dt, true);
      }
      const next = { ...spin, t: spin.t + dt };
      return next.t >= cruiseMs(next) + next.settleMs ? REST : next;
    }
  }
}

/** Where the cube is: its angle about the vertical from the logo pose, and how fast it turns. */
export function pose(spin: Spin): { angle: number; speed: number } {
  switch (spin.mode) {
    case "rest":
      return { angle: 0, speed: 0 };
    case "turn":
      return { angle: spin.angle, speed: spin.speed };
    case "stop": {
      const cruising = cruiseMs(spin);
      if (spin.t <= cruising) return { angle: spin.angle + spin.speed * spin.t, speed: spin.speed };
      const s = Math.min((spin.t - cruising) / spin.settleMs, 1);
      const k = (spin.speed * spin.settleMs) / spin.settle;
      return {
        angle: spin.angle + spin.cruise + spin.settle * settle(s, k),
        speed: (spin.settle / spin.settleMs) * settleRate(s, k),
      };
    }
  }
}

/** How long a stop keeps its speed before it settles. */
export function cruiseMs(stop: Extract<Spin, { mode: "stop" }>): number {
  return stop.cruise > 0 ? stop.cruise / stop.speed : 0;
}

function stopFrom(angle: number, speed: number): Spin {
  const left = QUARTER - angle; // to the next logo pose, never zero
  if (speed >= SLOWEST) {
    // Turn on at this speed, then brake over BRAKE_MS onto the first logo pose far enough ahead.
    const brake = (speed * BRAKE_MS) / 2; // settle() with k = 2 sets off at exactly this speed
    let distance = left;
    while (distance < brake) distance += QUARTER;
    return { mode: "stop", angle, speed, cruise: distance - brake, settle: brake, settleMs: BRAKE_MS, t: 0 };
  }
  // Barely started: glide on to the next logo pose, never faster than full speed and never back.
  let distance = left;
  let ms = glideMs(distance);
  while (speed * ms > 2 * distance) {
    distance += QUARTER;
    ms = glideMs(distance);
  }
  return { mode: "stop", angle, speed, cruise: 0, settle: distance, settleMs: ms, t: 0 };
}

function glideMs(distance: number): number {
  return Math.max(BRAKE_MS, (GLIDE_PEAK * distance) / CRUISE);
}

/**
 * From 0 to 1 over s in [0, 1], setting off at rate k (0 ≤ k ≤ 2) with no
 * acceleration and arriving at rest with none: the quintic that matches both
 * ends. k = 0 is a glide from rest to rest, k = 2 a brake from the speed it had.
 */
export function settle(s: number, k: number): number {
  return s * (k + s * s * (10 - 6 * k + s * (8 * k - 15 + s * (6 - 3 * k))));
}

/** The rate of settle() at s. */
export function settleRate(s: number, k: number): number {
  return k + s * s * (3 * (10 - 6 * k) + s * (4 * (8 * k - 15) + s * 5 * (6 - 3 * k)));
}

function smoothstep(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}
