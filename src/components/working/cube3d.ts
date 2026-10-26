// The Pattern Perspectives logo cube as a real cube: a unit cube turned by a
// quaternion, seen in the logo's isometric view and lit by a fixed light. At rest
// the projection is exactly metraglyph/site/public/favicon.svg, paths and tones;
// mid-turn every face shades by where it points, so the rotation reads as solid.

export type Vec3 = readonly [number, number, number];
/** A unit quaternion [w, x, y, z]. */
export type Quat = readonly [number, number, number, number];

export const IDENTITY: Quat = [1, 0, 0, 0];

export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const [x, y, z] = axis;
  const length = Math.hypot(x, y, z);
  const s = Math.sin(radians / 2) / length;
  return [Math.cos(radians / 2), x * s, y * s, z * s];
}

/** a ∘ b: rotate by b, then by a. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  // v' = v + 2w(u × v) + 2u × (u × v), with u the vector part.
  const cx = y * vz - z * vy;
  const cy = z * vx - x * vz;
  const cz = x * vy - y * vx;
  return [
    vx + 2 * (w * cx + y * cz - z * cy),
    vy + 2 * (w * cy + z * cx - x * cz),
    vz + 2 * (w * cz + x * cy - y * cx),
  ];
}

// The view: yaw 45° about the vertical, then pitch 35.26° towards the viewer
// (true isometric), looking down -z. The logo is that view squashed vertically
// by √3/2, so its rhombi come out 2:1.
const YAW = quatFromAxisAngle([0, 1, 0], Math.PI / 4);
const PITCH = quatFromAxisAngle([1, 0, 0], Math.atan(1 / Math.SQRT2));
const VIEW = quatMultiply(PITCH, YAW);
const SCALE = 28.16 / Math.SQRT2;
const SQUASH = Math.sqrt(3) / 2;

function toScreen(v: Vec3): readonly [number, number] {
  return [32 + SCALE * v[0], 32 - SCALE * SQUASH * v[1]];
}

// The six faces of the cube [-1, 1]³, each with its outward normal and corners
// wound the same way round as seen from outside.
const FACES: { normal: Vec3; corners: Vec3[] }[] = [
  { normal: [0, 1, 0], corners: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [1, 0, 0], corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
];

// The light comes from the top left, a little in front. Brightness is the cosine
// between a face's normal and the light, both in view space.
const LIGHT: Vec3 = (() => {
  const raw: Vec3 = [-0.5, 1, 0.3];
  const n = Math.hypot(...raw);
  return [raw[0] / n, raw[1] / n, raw[2] / n];
})();

function brightness(normal: Vec3): number {
  return normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2];
}

// The brightness of the logo's three faces at rest: these anchor the tones.
const REST = {
  top: brightness(rotate(VIEW, [0, 1, 0])),
  left: brightness(rotate(VIEW, [-1, 0, 0])),
  right: brightness(rotate(VIEW, [0, 0, 1])),
};

/** Tones from the darkest to the brightest: shadow, right, left, top, highlight. */
export type Palette = readonly [string, string, string, string, string];

export const PALETTES = {
  brand: ["#1f1137", "#46277a", "#7a60af", "#aa9ad1", "#dad2ef"],
  asking: ["#4d3d00", "#9c7a00", "#e0b100", "#f7dc6f", "#fff1b8"],
  failed: ["#4a0b16", "#a61e33", "#ff5363", "#ff9aa3", "#ffd3d7"],
} as const satisfies Record<string, Palette>;

function anchors(): number[] {
  const shadow = REST.right - (REST.left - REST.right);
  const highlight = Math.max(1, REST.top + 0.1);
  return [shadow, REST.right, REST.left, REST.top, highlight];
}
const ANCHORS = anchors();

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/** The tone of a face as bright as `b`, interpolated through the palette's anchors. */
export function shade(b: number, palette: Palette): string {
  if (b <= ANCHORS[0]!) return palette[0];
  for (let i = 1; i < ANCHORS.length; i++) {
    const hi = ANCHORS[i]!;
    if (b <= hi) {
      const lo = ANCHORS[i - 1]!;
      const t = (b - lo) / (hi - lo);
      const from = hexToRgb(palette[i - 1]!);
      const to = hexToRgb(palette[i]!);
      return rgbToHex([0, 1, 2].map((k) => from[k]! + (to[k]! - from[k]!) * t) as [number, number, number]);
    }
  }
  return palette[4];
}

export interface Face {
  d: string;
  fill: string;
}

/** The faces turned towards the viewer when the cube has orientation `q`. */
export function project(q: Quat, palette: Palette): Face[] {
  const turn = quatMultiply(VIEW, q);
  const faces: Face[] = [];
  for (const face of FACES) {
    const normal = rotate(turn, face.normal);
    if (normal[2] <= 1e-6) continue; // facing away; a convex cube needs no depth sort
    const points = face.corners.map((c) => toScreen(rotate(turn, c)));
    const d = "M" + points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L") + "Z";
    faces.push({ d, fill: shade(brightness(normal), palette) });
  }
  return faces;
}

/** Minimum-jerk easing: the speed rises and falls smoothly, as a hand turns a thing. */
export function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (10 + t * (-15 + 6 * t));
}
