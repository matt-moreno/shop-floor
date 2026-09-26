import type { Heightmap } from "./stock";

export interface Comparison {
  /** Share of relevant cells within tolerance, 0..1. */
  accuracy: number;
  /** Share of relevant cells with material left over. */
  remaining: number;
  /** Share of relevant cells cut too deep. */
  gouged: number;
  maxRemaining: number;
  maxGouge: number;
}

export const TOLERANCE = 0.1; // mm

/** Compare a cut part to the target, cell by cell. */
export function compare(actual: Heightmap, target: Heightmap): Comparison {
  let relevant = 0,
    left = 0,
    gouge = 0,
    maxLeft = 0,
    maxGouge = 0;
  const a = actual.heights;
  const t = target.heights;
  for (let k = 0; k < a.length; k++) {
    // Cells nobody touched don't count, so big blocks don't inflate the score.
    if (a[k] > -TOLERANCE && t[k] > -TOLERANCE) continue;
    relevant++;
    const d = a[k] - t[k];
    if (d > TOLERANCE) {
      left++;
      maxLeft = Math.max(maxLeft, d);
    } else if (d < -TOLERANCE) {
      gouge++;
      maxGouge = Math.max(maxGouge, -d);
    }
  }
  if (!relevant)
    return {
      accuracy: 1,
      remaining: 0,
      gouged: 0,
      maxRemaining: 0,
      maxGouge: 0,
    };
  return {
    accuracy: 1 - (left + gouge) / relevant,
    remaining: left / relevant,
    gouged: gouge / relevant,
    maxRemaining: maxLeft,
    maxGouge,
  };
}

export interface Grade {
  passed: boolean;
  stars: 0 | 1 | 2 | 3;
  reasons: string[];
}

export function grade(c: Comparison, time: number, par: number): Grade {
  const reasons: string[] = [];
  if (c.accuracy < 0.97)
    reasons.push(
      `Only ${(c.accuracy * 100).toFixed(1)}% of the part is in tolerance (need 97%).`,
    );
  if (c.gouged > 0.01)
    reasons.push(
      `${(c.gouged * 100).toFixed(1)}% of the part was cut too deep (up to ${c.maxGouge.toFixed(2)} mm). Scrap can't be fixed.`,
    );
  const passed = reasons.length === 0;
  const stars = !passed
    ? 0
    : time <= par * 1.02
      ? 3
      : time <= par * 1.4
        ? 2
        : 1;
  return { passed, stars, reasons };
}
