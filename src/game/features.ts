/**
 * What a job's finished part looks like, in design terms. Drives the
 * dimensioned drawing (and later, feature-based inspection).
 * All values are mm in work coordinates; depths are positive numbers.
 */
export type Feature =
  | { kind: "face"; depth: number }
  | {
      kind: "slot";
      x0: number;
      x1: number;
      y: number;
      width: number;
      depth: number;
    }
  | {
      kind: "pocket";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      depth: number;
      radius: number;
    }
  | {
      kind: "holes";
      cx: number;
      cy: number;
      /** Bolt circle diameter. */
      bc: number;
      count: number;
      dia: number;
      depth: number;
      /** Angle of the first hole, degrees CCW from +X. */
      startDeg: number;
    }
  | { kind: "boss"; cx: number; cy: number; dia: number; height: number }
  | {
      /** Rounded-rectangle outline left standing; everything around comes down. */
      kind: "plate";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      radius: number;
      height: number;
    }
  | {
      /** Round-ended notch cut in from the back (+Y) edge. */
      kind: "notch";
      x: number;
      /** Center of the round end. */
      y: number;
      width: number;
      depth: number;
    };

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRectDistance(
  f: { x0: number; y0: number; x1: number; y1: number; radius: number },
  x: number,
  y: number,
) {
  const hx = (f.x1 - f.x0) / 2,
    hy = (f.y1 - f.y0) / 2;
  const qx = Math.abs(x - (f.x0 + hx)) - hx + f.radius;
  const qy = Math.abs(y - (f.y0 + hy)) - hy + f.radius;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    f.radius
  );
}

export function holeCenters(f: Extract<Feature, { kind: "holes" }>) {
  return Array.from({ length: f.count }, (_, k) => {
    const a = ((f.startDeg + (360 * k) / f.count) * Math.PI) / 180;
    return {
      x: f.cx + (f.bc / 2) * Math.cos(a),
      y: f.cy + (f.bc / 2) * Math.sin(a),
    };
  });
}

/** Plain-language callout, as it would appear in a drawing's notes. */
export function callout(f: Feature): string {
  switch (f.kind) {
    case "face":
      return `Face top face, ${f.depth} deep (finished top at Z-${f.depth})`;
    case "slot":
      return `Slot ${f.width} wide × ${f.depth} deep, through in X`;
    case "pocket":
      return `Pocket ${f.x1 - f.x0} × ${f.y1 - f.y0}, ${f.depth} deep, R${f.radius} inside corners`;
    case "holes":
      return `${f.count}× Ø${f.dia} holes, ${f.depth} deep to the drill point, equally spaced on Ø${f.bc} bolt circle, first hole at ${f.startDeg}°`;
    case "boss":
      return `Ø${f.dia} round boss, ${f.height} tall; everything around it down ${f.height}`;
    case "plate":
      return `Plate ${f.x1 - f.x0} × ${f.y1 - f.y0}, R${f.radius} corners, ${f.height} tall; everything around it down ${f.height}`;
    case "notch":
      return `Notch ${f.width} wide with a full R${f.width / 2} end, ${f.depth} deep, from the back edge`;
  }
}

/**
 * Nominal finished height at (x, y), or null within `edge` mm of a feature
 * boundary (or on a drill point's cone), where the answer is ambiguous.
 */
export function nominalHeight(
  features: Feature[],
  x: number,
  y: number,
  edge = 0.6,
): number | null {
  let z = 0;
  for (const f of features) {
    switch (f.kind) {
      case "face":
        z = Math.min(z, -f.depth);
        break;
      case "slot": {
        if (x < f.x0 - edge || x > f.x1 + edge) break;
        const d = Math.abs(y - f.y) - f.width / 2;
        if (Math.abs(d) <= edge) return null;
        if (d < 0) z = Math.min(z, -f.depth);
        break;
      }
      case "pocket": {
        const sd = roundedRectDistance(f, x, y);
        if (Math.abs(sd) <= edge) return null;
        if (sd < 0) z = Math.min(z, -f.depth);
        break;
      }
      case "holes":
        for (const c of holeCenters(f)) {
          const d = Math.hypot(x - c.x, y - c.y);
          if (d < 0.3) z = Math.min(z, -f.depth);
          else if (d < f.dia / 2 + edge) return null;
        }
        break;
      case "boss": {
        const d = Math.hypot(x - f.cx, y - f.cy) - f.dia / 2;
        if (Math.abs(d) <= edge) return null;
        if (d > 0) z = Math.min(z, -f.height);
        break;
      }
      case "plate": {
        const sd = roundedRectDistance(f, x, y);
        if (Math.abs(sd) <= edge) return null;
        if (sd > 0) z = Math.min(z, -f.height);
        break;
      }
      case "notch": {
        const sd = Math.hypot(x - f.x, Math.min(0, y - f.y)) - f.width / 2;
        if (Math.abs(sd) <= edge) return null;
        if (sd < 0) z = Math.min(z, -f.depth);
        break;
      }
    }
  }
  return z;
}
