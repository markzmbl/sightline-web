import { useEffect, useLayoutEffect, useRef } from "react";
import { IDENTITY, PALETTES, project, quatFromAxisAngle, type Palette, type Vec3 } from "./cube3d";
import { REST, advance, pose, type Spin } from "./spin";
import { useReducedMotion } from "./useReducedMotion";
import "./working.css";

export type CubeState = "idle" | "working" | "asking" | "failed";

interface Props {
  state?: CubeState;
  size?: number;
  /** Forces reduced motion on or off; by default the viewer's setting decides. */
  reducedMotion?: boolean;
  label?: string;
}

const SPIN: Vec3 = [0, 1, 0]; // about the vertical: the cube turns like a top
// A frame later than this (a hidden tab, a busy main thread) goes on from where it was.
const MAX_STEP_MS = 50;

const PALETTE: Record<CubeState, Palette> = {
  idle: PALETTES.brand,
  working: PALETTES.brand,
  asking: PALETTES.asking,
  failed: PALETTES.failed,
};

/**
 * The Pattern Perspectives cube, turning while sightline works: a steady spin
 * about its vertical that eases in when work starts and, when it stops, brakes
 * onto the next quarter turn, so at rest it is the logo again.
 */
export function WorkingCube({ state = "idle", size = 16, reducedMotion, label }: Props) {
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const spin = useRef<Spin>(REST);
  const keepGoing = useRef(false);
  const lastFrame = useRef<number | null>(null);
  const frame = useRef(0);
  const palette = useRef(PALETTE[state]);
  const reduced = useReducedMotion(reducedMotion);
  const moving = state === "working" && !reduced;
  palette.current = PALETTE[state];

  function draw(angle: number) {
    const faces = project(quatFromAxisAngle(SPIN, angle), palette.current);
    paths.current.forEach((path, i) => {
      const face = faces[i];
      if (!path) return;
      path.setAttribute("d", face ? face.d : "");
      path.setAttribute("fill", face ? face.fill : "none");
      path.setAttribute("stroke", face ? face.fill : "none");
    });
  }

  function tick(now: number) {
    const dt = lastFrame.current === null ? 0 : Math.min(Math.max(now - lastFrame.current, 0), MAX_STEP_MS);
    lastFrame.current = now;
    spin.current = advance(spin.current, dt, keepGoing.current);
    draw(pose(spin.current).angle);
    if (spin.current.mode === "rest") {
      lastFrame.current = null; // at rest on the logo
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }

  // Draw the resting pose in the state's colours whenever it changes.
  useLayoutEffect(() => {
    if (spin.current.mode === "rest") draw(0);
  }, [state]);

  // Turn while working; on stop, turn on and brake onto the logo. Reduced motion stands still.
  useEffect(() => {
    keepGoing.current = moving;
    if (reduced) {
      spin.current = REST;
      lastFrame.current = null;
      draw(0);
      return;
    }
    if (!moving && spin.current.mode === "rest") return;
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [moving, reduced]);

  const pulse = state === "working" && reduced;
  const initial = project(IDENTITY, PALETTE[state]);
  return (
    <svg
      className={`cube cube--${state}${pulse ? " cube--pulse" : ""}`}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label={label ?? (state === "working" ? "Working" : "sightline")}
    >
      {[0, 1, 2].map((i) => (
        <path
          key={i}
          ref={(el) => {
            paths.current[i] = el;
          }}
          d={initial[i]?.d ?? ""}
          fill={initial[i]?.fill ?? "none"}
          stroke={initial[i]?.fill ?? "none"}
          strokeWidth={0.4}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
