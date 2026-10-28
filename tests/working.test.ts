import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  PALETTES,
  ease,
  project,
  quatFromAxisAngle,
  quatMultiply,
  type Face,
} from "../src/components/working/cube3d";
import { formatElapsed, stageLabel, WAITING } from "../src/components/working/stageLabels";

describe("stageLabel", () => {
  it("names the core's stages as gerunds", () => {
    expect(stageLabel("ground")).toBe("Grounding…");
    expect(stageLabel("idiom")).toBe("Choosing the idiom…");
    expect(stageLabel("ask")).toBe(WAITING);
    expect(stageLabel("plan")).toBe("Planning the analysis…");
    expect(stageLabel("gather")).toBe("Weighing the evidence…");
    expect(stageLabel("repair")).toBe("Rereading the question…");
  });

  it("shows a stage it does not know by its own name", () => {
    expect(stageLabel("analyse_split")).toBe("Analyse split…");
    expect(stageLabel(null)).toBe("Starting…");
  });
});

describe("formatElapsed", () => {
  it("counts seconds, then minutes", () => {
    expect(formatElapsed(14_900)).toBe("14s");
    expect(formatElapsed(85_000)).toBe("1:25");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

// A face as its fill and its set of corners, independent of where the path starts.
function canonical(faces: Face[]): string[] {
  return faces
    .map((f) => {
      const corners = (f.d.match(/-?[\d.]+ -?[\d.]+/g) ?? []).map((p) => p.replace(/-0\.00/g, "0.00")).sort();
      return `${f.fill} ${corners.join(" ")}`;
    })
    .sort();
}

// metraglyph/site/public/favicon.svg, path by path.
const FAVICON = [
  { fill: "#aa9ad1", d: "M3.84 17.92L32.00 3.84L60.16 17.92L32.00 32.00Z" },
  { fill: "#7a60af", d: "M3.84 17.92L32.00 32.00L32.00 60.16L3.84 46.08Z" },
  { fill: "#46277a", d: "M32.00 32.00L60.16 17.92L60.16 46.08L32.00 60.16Z" },
];

describe("the working cube", () => {
  it("is the favicon at rest", () => {
    expect(canonical(project(IDENTITY, PALETTES.brand))).toEqual(canonical(FAVICON));
  });

  it("is the favicon again after any quarter turn about a cube axis", () => {
    for (const axis of [[0, 1, 0], [1, 0, 0], [0, 0, 1]] as const) {
      const turned = quatMultiply(quatFromAxisAngle(axis, Math.PI / 2), IDENTITY);
      expect(canonical(project(turned, PALETTES.brand))).toEqual(canonical(FAVICON));
    }
  });

  it("shows two or three solid faces mid-turn, shaded between the logo's tones", () => {
    const mid = quatFromAxisAngle([0, 1, 0], Math.PI / 4);
    const faces = project(mid, PALETTES.brand);
    expect(faces.length).toBeGreaterThanOrEqual(2);
    expect(faces.length).toBeLessThanOrEqual(3);
    expect(faces.map((f) => f.fill)).toContain("#aa9ad1"); // the top still faces up
  });

  it("eases from rest to rest", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
    expect(ease(0.05)).toBeLessThan(0.01); // starts slowly
  });
});
