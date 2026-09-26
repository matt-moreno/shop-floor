import { getTool, type Tool } from "./tools";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Where the spindle sits at power-up, in work coordinates (mm). */
export const HOME: Vec3 = { x: 0, y: 0, z: 60 };
export const TRAVEL = {
  x: [-150, 250],
  y: [-120, 150],
  z: [-80, 60],
} as const;

export type Op =
  | {
      kind: "move";
      rapid: boolean;
      from: Vec3;
      to: Vec3;
      /** mm/min; ignored for rapids */
      feed: number;
      line: number;
    }
  | { kind: "dwell"; seconds: number; line: number }
  | { kind: "toolchange"; tool: number; spec: Tool; line: number }
  | { kind: "spindle"; rpm: number; dir: -1 | 0 | 1; line: number }
  | { kind: "coolant"; on: boolean; line: number }
  | { kind: "stop"; line: number }
  | { kind: "end"; line: number };

export interface Diagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
  /** "verify" marks a predicted alarm rather than a program error. */
  source?: "verify";
}

export interface Program {
  ops: Op[];
  diagnostics: Diagnostic[];
  /** True when the program stopped at an error before the end. */
  failed: boolean;
}

interface Block {
  line: number;
  words: { letter: string; value: number }[];
}

class GcodeError extends Error {
  /** Set when the problem belongs to an earlier line than the one being read. */
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
  }
}

const WORD = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

export function parseLine(text: string, line: number): Block {
  const stripped = text
    .replace(/\(.*?\)/g, " ")
    .replace(/;.*$/, "")
    .replace(/^\s*[%/]/, "");
  const words: Block["words"] = [];
  const leftover = stripped.replace(WORD, (_, l: string, v: string) => {
    words.push({ letter: l.toUpperCase(), value: parseFloat(v) });
    return " ";
  });
  const junk = leftover.trim();
  if (junk) throw new GcodeError(`Can't read "${junk}"`);
  return { line, words };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const eqCode = (a: number, b: number) => Math.abs(a - b) < 1e-6;

type Motion = 0 | 1 | 2 | 3 | 73 | 81 | 82 | 83 | null;
type Plane = 17 | 18 | 19;
const AXES: Record<Plane, [keyof Vec3, keyof Vec3, keyof Vec3]> = {
  17: ["x", "y", "z"],
  18: ["z", "x", "y"],
  19: ["y", "z", "x"],
};
const OFFSET_FOR: Record<keyof Vec3, string> = { x: "I", y: "J", z: "K" };

interface P2 {
  x: number;
  y: number;
}

/** A programmed XY move, kept while cutter compensation looks ahead. */
interface Seg {
  from: Vec3;
  to: Vec3;
  /** Set for arcs. */
  center?: P2;
  cw?: boolean;
  rapid: boolean;
  feed: number;
  line: number;
}

type Curve =
  { kind: "line"; p: P2; d: P2 } | { kind: "circle"; c: P2; r: number };

const cross2 = (a: P2, b: P2) => a.x * b.y - a.y * b.x;
const dist2 = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Signed angle swept from a0 to a1 going CW (negative) or CCW (positive). */
function sweepBetween(a0: number, a1: number, cw: boolean) {
  let sweep = a1 - a0;
  if (cw) {
    if (sweep >= -1e-9) sweep -= Math.PI * 2;
  } else if (sweep <= 1e-9) sweep += Math.PI * 2;
  return sweep;
}

function arcSweep(from: P2, to: P2, c: P2, cw: boolean) {
  return sweepBetween(
    Math.atan2(from.y - c.y, from.x - c.x),
    Math.atan2(to.y - c.y, to.x - c.x),
    cw,
  );
}

/** Direction of travel along a segment at point p. */
function tangentAt(s: Seg, p: P2): P2 {
  if (!s.center) {
    const dx = s.to.x - s.from.x,
      dy = s.to.y - s.from.y;
    const l = Math.hypot(dx, dy);
    return { x: dx / l, y: dy / l };
  }
  const vx = p.x - s.center.x,
    vy = p.y - s.center.y;
  const l = Math.hypot(vx, vy);
  return s.cw ? { x: vy / l, y: -vx / l } : { x: -vy / l, y: vx / l };
}

/** Shift p by k to the left of travel direction t (right when k < 0). */
const shiftLeft = (p: P2, t: P2, k: number): P2 => ({
  x: p.x - t.y * k,
  y: p.y + t.x * k,
});

function offsetCurve(s: Seg, k: number): Curve {
  if (!s.center)
    return {
      kind: "line",
      p: shiftLeft(s.from, tangentAt(s, s.from), k),
      d: tangentAt(s, s.from),
    };
  const r = dist2(s.from, s.center);
  // Left of a CCW arc is toward the center.
  return { kind: "circle", c: s.center, r: r + (s.cw ? k : -k) };
}

/** Intersection of two curves nearest to `near`, or null. */
function intersect(a: Curve, b: Curve, near: P2): P2 | null {
  const pick = (pts: P2[]) =>
    pts.length
      ? pts.reduce((m, p) => (dist2(p, near) < dist2(m, near) ? p : m))
      : null;
  if (a.kind === "line" && b.kind === "line") {
    const c = cross2(a.d, b.d);
    if (Math.abs(c) < 1e-9) return null;
    const t = cross2({ x: b.p.x - a.p.x, y: b.p.y - a.p.y }, b.d) / c;
    return { x: a.p.x + t * a.d.x, y: a.p.y + t * a.d.y };
  }
  if (a.kind === "circle" && b.kind === "line") return intersect(b, a, near);
  if (a.kind === "line" && b.kind === "circle") {
    const fx = a.p.x - b.c.x,
      fy = a.p.y - b.c.y;
    const B = fx * a.d.x + fy * a.d.y;
    let disc = B * B - (fx * fx + fy * fy - b.r * b.r);
    if (disc < -1e-6) return null;
    disc = Math.max(0, disc);
    const q = Math.sqrt(disc);
    return pick(
      [-B - q, -B + q].map((t) => ({
        x: a.p.x + t * a.d.x,
        y: a.p.y + t * a.d.y,
      })),
    );
  }
  if (a.kind === "circle" && b.kind === "circle") {
    const d = dist2(a.c, b.c);
    if (d < 1e-9 || d > a.r + b.r || d < Math.abs(a.r - b.r)) return null;
    const m = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a.r * a.r - m * m));
    const ux = (b.c.x - a.c.x) / d,
      uy = (b.c.y - a.c.y) / d;
    const mx = a.c.x + m * ux,
      my = a.c.y + m * uy;
    return pick([
      { x: mx - h * uy, y: my + h * ux },
      { x: mx + h * uy, y: my - h * ux },
    ]);
  }
  return null;
}

export interface InterpretOptions {
  /** The job's tool rack. Tools it doesn't list come from the library. */
  rack?: Tool[];
}

export function interpret(
  source: string,
  { rack }: InterpretOptions = {},
): Program {
  const ops: Op[] = [];
  const diagnostics: Diagnostic[] = [];
  /** Where the tool center is. */
  const pos: Vec3 = { ...HOME };
  /** Where the program says it is; differs from pos under compensation. */
  const prog: Vec3 = { ...HOME };
  let motion: Motion = null;
  let plane: Plane = 17;
  let absolute = true;
  let scale = 1;
  let feed = 0;
  let pendingTool = 0;
  let loadedTool = 0;
  let spindleOn = false;
  let retractToInitial = true;
  const cycle = { z: NaN, r: NaN, q: NaN, p: 0, initialZ: 0 };
  let failed = false;
  let ended = false;

  // Cutter compensation. D registers default to each library tool's
  // nominal radius; G10 L12 overwrites them.
  const radiusOffsets = new Map<number, number>();
  let dReg: number | null = null;
  /** Signed offset: + puts the tool left of the path (G41), - right (G42). */
  let compK = 0;
  /**
   * off: not active. armed: G41/G42 read, no XY move yet. lead: the lead-in
   * move is waiting to see where the contour starts. contour: `prev` is
   * waiting to see the next move so its end corner can be resolved.
   */
  let compPhase: "off" | "armed" | "lead" | "contour" = "off";
  let lead: { z: number; rapid: boolean; feed: number; line: number } | null =
    null;
  let prev: Seg | null = null;
  /** Z-only moves and events held back until the corner ahead is known. */
  let queue: (
    { op: Op } | { z: number; rapid: boolean; feed: number; line: number }
  )[] = [];
  const compensating = () => compPhase === "lead" || compPhase === "contour";

  const warn = (line: number, message: string) =>
    diagnostics.push({ line, severity: "warning", message });

  const lookupTool = (n: number) =>
    rack?.find((t) => t.number === n) ?? getTool(n);

  const radiusFor = (d: number) => {
    if (radiusOffsets.has(d)) return radiusOffsets.get(d)!;
    if (d === 0) return 0;
    const t = getTool(d);
    if (!t)
      throw new GcodeError(
        `D${d} has no offset. D1-D6 hold each tool's radius; set others with G10 L12 P${d} R…`,
      );
    return t.diameter / 2;
  };

  const moveTo = (to: Vec3, rapid: boolean, line: number, f = feed) => {
    const target = { x: round(to.x), y: round(to.y), z: round(to.z) };
    if (target.x === pos.x && target.y === pos.y && target.z === pos.z) return;
    for (const axis of ["x", "y", "z"] as const) {
      const [lo, hi] = TRAVEL[axis];
      if (target[axis] < lo || target[axis] > hi)
        throw new GcodeError(
          `${axis.toUpperCase()}${target[axis]} is past machine travel (${lo} to ${hi})`,
          line,
        );
    }
    if (!rapid && f <= 0)
      throw new GcodeError("Feed move with no feed rate. Add an F word.", line);
    ops.push({
      kind: "move",
      rapid,
      from: { ...pos },
      to: target,
      feed: f,
      line,
    });
    Object.assign(pos, target);
  };

  /** Arc from the current tool position to `end` around (ca, cb) in plane pl. */
  const arcMoves = (
    end: Vec3,
    ca: number,
    cb: number,
    cw: boolean,
    line: number,
    f: number,
    pl: Plane,
  ) => {
    const [a, b, c] = AXES[pl];
    const start = { ...pos };
    const radius = Math.hypot(start[a] - ca, start[b] - cb);
    const a0 = Math.atan2(start[b] - cb, start[a] - ca);
    const sweep = sweepBetween(a0, Math.atan2(end[b] - cb, end[a] - ca), cw);
    const step = 2 * Math.acos(Math.max(-1, 1 - 0.01 / Math.max(radius, 0.01)));
    const n = Math.max(4, Math.ceil(Math.abs(sweep) / step));
    for (let k = 1; k <= n; k++) {
      const th = a0 + (sweep * k) / n;
      const p = { ...start };
      p[a] = ca + radius * Math.cos(th);
      p[b] = cb + radius * Math.sin(th);
      p[c] = start[c] + ((end[c] - start[c]) * k) / n;
      if (k === n) Object.assign(p, end);
      moveTo(p, false, line, f);
    }
  };

  const emit = (op: Op) => (compensating() ? queue.push({ op }) : ops.push(op));

  const flushQueue = () => {
    for (const q of queue) {
      if ("op" in q) ops.push(q.op);
      else moveTo({ ...pos, z: q.z }, q.rapid, q.line, q.feed);
    }
    queue = [];
  };

  const overcut = (line: number, why: string) =>
    new GcodeError(
      `Cutter compensation: ${why}. The tool is too big for this shape; use a smaller cutter.`,
      line,
    );

  /** Cut a compensated segment from the tool's position to E. */
  const emitSeg = (s: Seg, E: P2) => {
    const S = { x: pos.x, y: pos.y };
    const end = { x: E.x, y: E.y, z: s.to.z };
    if (!s.center) {
      const t = tangentAt(s, S);
      if ((E.x - S.x) * t.x + (E.y - S.y) * t.y < -1e-4)
        throw overcut(s.line, "the offset path would run backwards here");
      moveTo(end, s.rapid, s.line, s.feed);
    } else {
      const want = Math.abs(arcSweep(s.from, s.to, s.center, s.cw!));
      const got = Math.abs(arcSweep(S, E, s.center, s.cw!));
      if (got > want + 1e-3)
        throw overcut(s.line, "the offset arc would wrap past its end");
      arcMoves(end, s.center.x, s.center.y, s.cw!, s.line, s.feed, 17);
    }
  };

  /** Finish the pending segment square to its end, and turn compensation off. */
  const finishComp = () => {
    if (compPhase === "lead" && lead) {
      moveTo({ ...prog, z: lead.z }, lead.rapid, lead.line, lead.feed);
    } else if (compPhase === "contour" && prev) {
      const J = { x: prev.to.x, y: prev.to.y };
      emitSeg(prev, shiftLeft(J, tangentAt(prev, J), compK));
    }
    flushQueue();
    compPhase = "off";
    prev = null;
    lead = null;
  };

  /** A G0-G3 move while compensation is on. */
  const compMove = (seg: Seg) => {
    if (!seg.center && seg.from.x === seg.to.x && seg.from.y === seg.to.y) {
      // Z only: it happens wherever the tool ends up for this corner.
      queue.push({
        z: seg.to.z,
        rapid: seg.rapid,
        feed: seg.feed,
        line: seg.line,
      });
      return;
    }
    if (seg.center) {
      const r = dist2(seg.from, seg.center) + (seg.cw ? compK : -compK);
      if (r < 1e-3)
        throw overcut(
          seg.line,
          `a radius ${Math.abs(compK)} offset doesn't fit inside this R${round(dist2(seg.from, seg.center))} arc`,
        );
    }
    if (compPhase === "lead") {
      const S = shiftLeft(seg.from, tangentAt(seg, seg.from), compK);
      moveTo({ ...S, z: lead!.z }, lead!.rapid, lead!.line, lead!.feed);
      flushQueue();
    } else {
      const A = prev!;
      const J = { x: A.to.x, y: A.to.y };
      const tA = tangentAt(A, J),
        tB = tangentAt(seg, J);
      const eA = shiftLeft(J, tA, compK),
        sB = shiftLeft(J, tB, compK);
      // Tangent within a micron (R-format centers carry float noise).
      if (dist2(eA, sB) < 1e-3) {
        emitSeg(A, eA);
        flushQueue();
      } else if (compK * cross2(tA, tB) > 0) {
        // Inside corner: stop where the two offset paths cross.
        const X = intersect(offsetCurve(A, compK), offsetCurve(seg, compK), J);
        if (!X) throw overcut(seg.line, "the inside corner here is too tight");
        emitSeg(A, X);
        flushQueue();
      } else {
        // Outside corner: roll around it, which keeps the part corner sharp.
        emitSeg(A, eA);
        flushQueue();
        arcMoves(
          { ...sB, z: pos.z },
          J.x,
          J.y,
          compK > 0,
          seg.line,
          seg.feed,
          17,
        );
      }
    }
    compPhase = "contour";
    prev = seg;
  };

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length && !ended; i++) {
    const lineNo = i + 1;
    try {
      const block = parseLine(lines[i], lineNo);
      if (!block.words.length) continue;
      const get = (l: string) => block.words.find((w) => w.letter === l);
      const has = (l: string) => block.words.some((w) => w.letter === l);
      const gs = block.words
        .filter((w) => w.letter === "G")
        .map((w) => w.value);
      const ms = block.words
        .filter((w) => w.letter === "M")
        .map((w) => w.value);
      const hasG = (n: number) => gs.some((g) => eqCode(g, n));
      const hasM = (n: number) => ms.some((m) => eqCode(m, n));
      // After a bare G40 the tool is still offset; keep the programmed spot.
      let holdProg = false;

      for (const w of block.words) {
        if (!"GMXYZIJKRFSTPQHDNL".includes(w.letter))
          warn(lineNo, `${w.letter} words are not supported; ignored`);
      }
      const known = [
        0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 40, 41, 42, 43, 49, 54, 73,
        80, 81, 82, 83, 90, 91, 94, 98, 99,
      ];
      for (const g of gs) {
        if (g >= 55 && g <= 59)
          warn(lineNo, `G${g}: only G54 is set up on this machine; using G54`);
        else if (!known.some((k) => eqCode(k, g)))
          warn(lineNo, `G${g} is not supported; ignored`);
      }

      // Units first, so the rest of the block scales correctly.
      if (hasG(20)) scale = 25.4;
      if (hasG(21)) scale = 1;

      const f = get("F");
      if (f) feed = f.value * scale;
      const t = get("T");
      if (t) pendingTool = Math.round(t.value);

      if (hasG(10)) {
        const l = get("L"),
          p = get("P"),
          r = get("R");
        if (!l || !eqCode(l.value, 12))
          throw new GcodeError(
            "Only G10 L12 (set a tool radius offset) is supported",
          );
        if (!p || !r || p.value < 1 || p.value > 99 || p.value % 1)
          throw new GcodeError(
            "G10 L12 needs a register P1-P99 and a radius R, e.g. G10 L12 P2 R4.9",
          );
        if (compensating())
          throw new GcodeError("Change offsets with compensation off (G40)");
        radiusOffsets.set(p.value, r.value * scale);
      }

      const d = get("D");
      const startComp = hasG(41) || hasG(42);
      if (d) {
        const n = Math.round(d.value);
        if (compensating() && !startComp && n !== dReg)
          throw new GcodeError("Change D only with compensation off (G40)");
        dReg = n;
      }

      if (hasM(6)) {
        if (compPhase !== "off")
          throw new GcodeError(
            "Cancel cutter compensation (G40) before a tool change",
          );
        const spec = lookupTool(pendingTool);
        if (!spec)
          throw new GcodeError(`T${pendingTool} is not in the tool library`);
        if (spindleOn) {
          ops.push({ kind: "spindle", rpm: 0, dir: 0, line: lineNo });
          spindleOn = false;
        }
        moveTo({ ...pos, z: HOME.z }, true, lineNo);
        ops.push({ kind: "toolchange", tool: pendingTool, spec, line: lineNo });
        loadedTool = pendingTool;
      }

      const s = get("S");
      if (hasM(3) || hasM(4)) {
        const rpm = s?.value ?? 0;
        if (rpm <= 0)
          throw new GcodeError("Spindle start needs a speed. Add an S word.");
        if (rpm > 12000)
          throw new GcodeError(`S${rpm} is above the 12000 rpm spindle limit`);
        emit({ kind: "spindle", rpm, dir: hasM(3) ? 1 : -1, line: lineNo });
        spindleOn = true;
      } else if (s && spindleOn) {
        if (s.value > 12000)
          throw new GcodeError(
            `S${s.value} is above the 12000 rpm spindle limit`,
          );
        emit({ kind: "spindle", rpm: s.value, dir: 1, line: lineNo });
      }
      if (hasM(5)) {
        emit({ kind: "spindle", rpm: 0, dir: 0, line: lineNo });
        spindleOn = false;
      }
      if (hasM(8)) emit({ kind: "coolant", on: true, line: lineNo });
      if (hasM(9)) emit({ kind: "coolant", on: false, line: lineNo });

      if (hasG(4)) {
        const p = get("P")?.value ?? 0;
        emit({ kind: "dwell", seconds: p, line: lineNo });
      }

      const newPlane: Plane = hasG(17)
        ? 17
        : hasG(18)
          ? 18
          : hasG(19)
            ? 19
            : plane;
      if (newPlane !== 17 && (compPhase !== "off" || startComp))
        throw new GcodeError(
          "Cutter compensation works in the G17 (XY) plane only",
        );
      plane = newPlane;
      if (hasG(90)) absolute = true;
      if (hasG(91)) absolute = false;
      if (hasG(98)) retractToInitial = true;
      if (hasG(99)) retractToInitial = false;
      if (hasG(80)) motion = null;

      const axisWord = (a: keyof Vec3) => get(a.toUpperCase());
      const hasAxis = ["X", "Y", "Z"].some(has);
      const target = (): Vec3 => {
        const out = { ...prog };
        for (const a of ["x", "y", "z"] as const) {
          const w = axisWord(a);
          if (w)
            out[a] = absolute ? w.value * scale : prog[a] + w.value * scale;
        }
        return out;
      };

      if (hasG(41) && hasG(42))
        throw new GcodeError("G41 and G42 can't be on the same line");
      const cancelComp = hasG(40);
      if (startComp) {
        if (cancelComp)
          throw new GcodeError("G40 and G41/G42 can't be on the same line");
        if (dReg === null)
          throw new GcodeError(
            "Cutter compensation needs a D word for the tool radius, e.g. G41 D2",
          );
        const k = (hasG(41) ? 1 : -1) * radiusFor(dReg);
        if (compensating() && k !== compK)
          throw new GcodeError("Cancel with G40 before changing G41/G42 or D");
        if (!compensating()) {
          compK = k;
          compPhase = "armed";
          if (dReg !== loadedTool && dReg !== 0 && !radiusOffsets.has(dReg))
            warn(
              lineNo,
              loadedTool
                ? `D${dReg} holds T${dReg}'s radius, but T${loadedTool} is loaded`
                : `No tool loaded; D${dReg} is T${dReg}'s radius`,
            );
        }
      }
      if (cancelComp && compPhase === "armed") compPhase = "off";

      if (hasG(28)) {
        if (compPhase !== "off")
          throw new GcodeError("Cancel cutter compensation (G40) before G28");
        if (hasAxis) moveTo(target(), true, lineNo);
        const which = (["x", "y", "z"] as const).filter((a) => axisWord(a));
        const home = { ...pos };
        for (const a of which.length ? which : (["z", "x", "y"] as const))
          home[a] = HOME[a];
        // Z retracts first, then XY, like a real reference return.
        moveTo({ ...pos, z: home.z }, true, lineNo);
        moveTo(home, true, lineNo);
      } else {
        for (const m of [0, 1, 2, 3, 73, 81, 82, 83] as const) {
          if (hasG(m)) {
            motion = m;
            if (m >= 73) cycle.initialZ = pos.z;
          }
        }
        if (
          cancelComp &&
          compensating() &&
          !(hasAxis && motion !== null && motion <= 1)
        ) {
          if (hasAxis && (motion === 2 || motion === 3))
            throw new GcodeError(
              "Cancel compensation on a straight G0/G1 move, not an arc",
            );
          if (compPhase === "lead")
            throw new GcodeError(
              "Compensation was cancelled before any contour. Put the part's moves between G41/G42 and G40.",
            );
          finishComp();
          holdProg = !hasAxis;
        }
        if (hasAxis) {
          if (motion === null)
            throw new GcodeError(
              "Axis words with no motion mode. Add G0 or G1.",
            );
          if (motion >= 73 && compPhase !== "off")
            throw new GcodeError(
              "Cancel cutter compensation (G40) before drilling cycles",
            );
          const to = target();
          if (compPhase === "off") {
            if (motion === 0 || motion === 1) moveTo(to, motion === 0, lineNo);
            else if (motion === 2 || motion === 3) {
              const [ca, cb] = arcCenter(to, motion === 2);
              arcMoves(to, ca, cb, motion === 2, lineNo, feed, plane);
            } else cannedCycle(motion, lineNo);
          } else if (compPhase === "armed") {
            if (motion === 2 || motion === 3)
              throw new GcodeError(
                "Start cutter compensation with a straight G0/G1 lead-in move, not an arc",
              );
            if (to.x === prog.x && to.y === prog.y)
              moveTo(to, motion === 0, lineNo);
            else {
              lead = { z: to.z, rapid: motion === 0, feed, line: lineNo };
              compPhase = "lead";
            }
          } else if (cancelComp) {
            if (compPhase === "lead")
              throw new GcodeError(
                "Compensation was cancelled before any contour. Put the part's moves between G41/G42 and G40.",
              );
            finishComp();
            moveTo(to, motion === 0, lineNo);
          } else {
            const seg: Seg = {
              from: { ...prog },
              to,
              rapid: motion === 0,
              feed,
              line: lineNo,
            };
            if (motion === 2 || motion === 3) {
              const [cx, cy] = arcCenter(to, motion === 2);
              seg.center = { x: cx, y: cy };
              seg.cw = motion === 2;
            }
            if (!seg.rapid && feed <= 0)
              throw new GcodeError(
                "Feed move with no feed rate. Add an F word.",
              );
            compMove(seg);
          }
          Object.assign(prog, to);
        }
      }
      if (compPhase === "off" && !holdProg) Object.assign(prog, pos);

      if (hasM(0) || hasM(1)) emit({ kind: "stop", line: lineNo });
      if (hasM(2) || hasM(30)) {
        if (compensating()) {
          warn(
            lineNo,
            "Cutter compensation is still on at the end. Cancel it with G40.",
          );
          finishComp();
        }
        if (spindleOn)
          ops.push({ kind: "spindle", rpm: 0, dir: 0, line: lineNo });
        ops.push({ kind: "end", line: lineNo });
        ended = true;
      }

      /** Arc center in the active plane, from the programmed start. */
      function arcCenter(end: Vec3, cw: boolean): [number, number] {
        const [a, b] = AXES[plane];
        const start = prog;
        const r = get("R");
        if (r) {
          const R = r.value * scale;
          const dx = end[a] - start[a];
          const dy = end[b] - start[b];
          const d = Math.hypot(dx, dy);
          if (d < 1e-9)
            throw new GcodeError(
              "R-format arc needs an end point that differs from the start",
            );
          if (d > 2 * Math.abs(R) + 1e-4)
            throw new GcodeError(
              `Arc radius R${r.value} is too small to reach the end point`,
            );
          const h = Math.sqrt(Math.max(0, R * R - (d / 2) ** 2));
          // Center is left of the chord for CCW, right for CW; negative R flips it.
          const side = (cw ? -1 : 1) * (R < 0 ? -1 : 1);
          return [
            start[a] + dx / 2 - (side * h * dy) / d,
            start[b] + dy / 2 + (side * h * dx) / d,
          ];
        }
        const oa = get(OFFSET_FOR[a]);
        const ob = get(OFFSET_FOR[b]);
        if (!oa && !ob)
          throw new GcodeError(
            `Arc needs a center (${OFFSET_FOR[a]}${OFFSET_FOR[b]}) or a radius (R)`,
          );
        const ca = start[a] + (oa?.value ?? 0) * scale;
        const cb = start[b] + (ob?.value ?? 0) * scale;
        const r0 = Math.hypot(start[a] - ca, start[b] - cb);
        const r1 = Math.hypot(end[a] - ca, end[b] - cb);
        if (Math.abs(r0 - r1) > 0.01)
          throw new GcodeError(
            `Arc end point is ${round(Math.abs(r0 - r1))} mm off the circle. Check the end point and center.`,
          );
        return [ca, cb];
      }

      function cannedCycle(kind: 73 | 81 | 82 | 83, line: number) {
        if (!absolute)
          throw new GcodeError(
            "Drilling cycles need G90 (absolute) in this simulator",
          );
        if (plane !== 17)
          throw new GcodeError("Drilling cycles need the G17 plane");
        const z = get("Z");
        const r = get("R");
        const q = get("Q");
        const p = get("P");
        if (z) cycle.z = z.value * scale;
        if (r) cycle.r = r.value * scale;
        if (q) cycle.q = q.value * scale;
        if (p) cycle.p = p.value;
        if (Number.isNaN(cycle.z))
          throw new GcodeError("Drilling cycle needs a depth (Z)");
        if (Number.isNaN(cycle.r))
          throw new GcodeError("Drilling cycle needs a retract plane (R)");
        if ((kind === 83 || kind === 73) && !(cycle.q > 0))
          throw new GcodeError(`G${kind} needs a peck depth (Q) above zero`);
        if (cycle.z >= cycle.r)
          throw new GcodeError("Drill depth Z must be below R");
        const xy = {
          x: get("X") ? get("X")!.value * scale : pos.x,
          y: get("Y") ? get("Y")!.value * scale : pos.y,
        };
        const clearZ = Math.max(cycle.initialZ, cycle.r);
        if (pos.z < cycle.r) moveTo({ ...pos, z: cycle.r }, true, line);
        moveTo({ ...xy, z: pos.z }, true, line);
        moveTo({ ...xy, z: cycle.r }, true, line);
        if (kind === 81 || kind === 82) {
          moveTo({ ...xy, z: cycle.z }, false, line);
          if (kind === 82 && cycle.p > 0)
            ops.push({ kind: "dwell", seconds: cycle.p, line });
        } else {
          let depth = cycle.r;
          while (depth > cycle.z + 1e-6) {
            const next = Math.max(cycle.z, depth - cycle.q);
            if (kind === 83 && depth < cycle.r)
              moveTo({ ...xy, z: depth + 0.5 }, true, line);
            moveTo({ ...xy, z: next }, false, line);
            depth = next;
            if (depth > cycle.z + 1e-6) {
              if (kind === 83) moveTo({ ...xy, z: cycle.r }, true, line);
              else moveTo({ ...xy, z: depth + 0.5 }, true, line);
            }
          }
        }
        moveTo({ ...xy, z: retractToInitial ? clearZ : cycle.r }, true, line);
      }
    } catch (e) {
      if (!(e instanceof GcodeError)) throw e;
      diagnostics.push({
        line: e.line ?? lineNo,
        severity: "error",
        message: e.message,
      });
      failed = true;
      break;
    }
  }
  if (!failed && !ended) {
    if (compensating()) {
      try {
        finishComp();
      } catch (e) {
        if (!(e instanceof GcodeError)) throw e;
        diagnostics.push({
          line: e.line ?? lines.length,
          severity: "error",
          message: e.message,
        });
        failed = true;
      }
    }
    if (!failed) warn(lines.length, "Program has no M30 at the end");
  }
  if (ended) {
    const endLine = ops[ops.length - 1].line;
    const after = lines.slice(endLine).findIndex((l) => {
      try {
        return parseLine(l, 0).words.length > 0;
      } catch {
        return true;
      }
    });
    if (after >= 0)
      warn(
        endLine + after + 1,
        "Program ended at M30; lines after it never run",
      );
  }
  return { ops, diagnostics, failed };
}
