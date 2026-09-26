import { getTool } from "./tools";

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
  | { kind: "toolchange"; tool: number; line: number }
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

class GcodeError extends Error {}

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

export function interpret(source: string): Program {
  const ops: Op[] = [];
  const diagnostics: Diagnostic[] = [];
  const pos: Vec3 = { ...HOME };
  let motion: Motion = null;
  let plane: Plane = 17;
  let absolute = true;
  let scale = 1;
  let feed = 0;
  let pendingTool = 0;
  let spindleOn = false;
  let retractToInitial = true;
  const cycle = { z: NaN, r: NaN, q: NaN, p: 0, initialZ: 0 };
  let failed = false;
  let ended = false;

  const warn = (line: number, message: string) =>
    diagnostics.push({ line, severity: "warning", message });

  const moveTo = (to: Vec3, rapid: boolean, line: number) => {
    const target = { x: round(to.x), y: round(to.y), z: round(to.z) };
    if (target.x === pos.x && target.y === pos.y && target.z === pos.z) return;
    for (const axis of ["x", "y", "z"] as const) {
      const [lo, hi] = TRAVEL[axis];
      if (target[axis] < lo || target[axis] > hi)
        throw new GcodeError(
          `${axis.toUpperCase()}${target[axis]} is past machine travel (${lo} to ${hi})`,
        );
    }
    if (!rapid && feed <= 0)
      throw new GcodeError("Feed move with no feed rate. Add an F word.");
    ops.push({ kind: "move", rapid, from: { ...pos }, to: target, feed, line });
    Object.assign(pos, target);
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

      for (const w of block.words) {
        if (!"GMXYZIJKRFSTPQHDNL".includes(w.letter))
          warn(lineNo, `${w.letter} words are not supported; ignored`);
      }
      const known = [
        0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 28, 40, 43, 49, 54, 73, 80, 81, 82,
        83, 90, 91, 94, 98, 99,
      ];
      for (const g of gs) {
        if (g >= 55 && g <= 59)
          warn(lineNo, `G${g}: only G54 is set up on this machine; using G54`);
        else if (eqCode(g, 41) || eqCode(g, 42))
          warn(lineNo, `G${g} cutter compensation is not simulated; ignored`);
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

      if (hasM(6)) {
        if (!getTool(pendingTool))
          throw new GcodeError(`T${pendingTool} is not in the tool library`);
        if (spindleOn) {
          ops.push({ kind: "spindle", rpm: 0, dir: 0, line: lineNo });
          spindleOn = false;
        }
        moveTo({ ...pos, z: HOME.z }, true, lineNo);
        ops.push({ kind: "toolchange", tool: pendingTool, line: lineNo });
      }

      const s = get("S");
      if (hasM(3) || hasM(4)) {
        const rpm = s?.value ?? 0;
        if (rpm <= 0)
          throw new GcodeError("Spindle start needs a speed. Add an S word.");
        if (rpm > 12000)
          throw new GcodeError(`S${rpm} is above the 12000 rpm spindle limit`);
        ops.push({ kind: "spindle", rpm, dir: hasM(3) ? 1 : -1, line: lineNo });
        spindleOn = true;
      } else if (s && spindleOn) {
        if (s.value > 12000)
          throw new GcodeError(
            `S${s.value} is above the 12000 rpm spindle limit`,
          );
        ops.push({ kind: "spindle", rpm: s.value, dir: 1, line: lineNo });
      }
      if (hasM(5)) {
        ops.push({ kind: "spindle", rpm: 0, dir: 0, line: lineNo });
        spindleOn = false;
      }
      if (hasM(8)) ops.push({ kind: "coolant", on: true, line: lineNo });
      if (hasM(9)) ops.push({ kind: "coolant", on: false, line: lineNo });

      if (hasG(4)) {
        const p = get("P")?.value ?? 0;
        ops.push({ kind: "dwell", seconds: p, line: lineNo });
      }

      if (hasG(17)) plane = 17;
      if (hasG(18)) plane = 18;
      if (hasG(19)) plane = 19;
      if (hasG(90)) absolute = true;
      if (hasG(91)) absolute = false;
      if (hasG(98)) retractToInitial = true;
      if (hasG(99)) retractToInitial = false;
      if (hasG(80)) motion = null;

      const axisWord = (a: keyof Vec3) => get(a.toUpperCase());
      const hasAxis = ["X", "Y", "Z"].some(has);
      const target = (): Vec3 => {
        const out = { ...pos };
        for (const a of ["x", "y", "z"] as const) {
          const w = axisWord(a);
          if (w) out[a] = absolute ? w.value * scale : pos[a] + w.value * scale;
        }
        return out;
      };

      if (hasG(28)) {
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
        if (hasAxis) {
          if (motion === null)
            throw new GcodeError(
              "Axis words with no motion mode. Add G0 or G1.",
            );
          if (motion === 0 || motion === 1)
            moveTo(target(), motion === 0, lineNo);
          else if (motion === 2 || motion === 3)
            arc(target(), motion === 2, lineNo);
          else cannedCycle(motion, lineNo);
        }
      }

      if (hasM(0) || hasM(1)) ops.push({ kind: "stop", line: lineNo });
      if (hasM(2) || hasM(30)) {
        if (spindleOn)
          ops.push({ kind: "spindle", rpm: 0, dir: 0, line: lineNo });
        ops.push({ kind: "end", line: lineNo });
        ended = true;
      }

      function arc(end: Vec3, cw: boolean, line: number) {
        const [a, b, c] = AXES[plane];
        const start = { ...pos };
        let ca: number, cb: number;
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
          ca = start[a] + dx / 2 - (side * h * dy) / d;
          cb = start[b] + dy / 2 + (side * h * dx) / d;
        } else {
          const oa = get(OFFSET_FOR[a]);
          const ob = get(OFFSET_FOR[b]);
          if (!oa && !ob)
            throw new GcodeError(
              `Arc needs a center (${OFFSET_FOR[a]}${OFFSET_FOR[b]}) or a radius (R)`,
            );
          ca = start[a] + (oa?.value ?? 0) * scale;
          cb = start[b] + (ob?.value ?? 0) * scale;
          const r0 = Math.hypot(start[a] - ca, start[b] - cb);
          const r1 = Math.hypot(end[a] - ca, end[b] - cb);
          if (Math.abs(r0 - r1) > 0.01)
            throw new GcodeError(
              `Arc end point is ${round(Math.abs(r0 - r1))} mm off the circle. Check the end point and center.`,
            );
        }
        const radius = Math.hypot(start[a] - ca, start[b] - cb);
        const a0 = Math.atan2(start[b] - cb, start[a] - ca);
        const a1 = Math.atan2(end[b] - cb, end[a] - ca);
        let sweep = a1 - a0;
        if (cw) {
          if (sweep >= -1e-9) sweep -= Math.PI * 2;
        } else if (sweep <= 1e-9) sweep += Math.PI * 2;
        const step =
          2 * Math.acos(Math.max(-1, 1 - 0.01 / Math.max(radius, 0.01)));
        const n = Math.max(4, Math.ceil(Math.abs(sweep) / step));
        for (let k = 1; k <= n; k++) {
          const th = a0 + (sweep * k) / n;
          const p = { ...start };
          p[a] = ca + radius * Math.cos(th);
          p[b] = cb + radius * Math.sin(th);
          p[c] = start[c] + ((end[c] - start[c]) * k) / n;
          if (k === n) Object.assign(p, end);
          moveTo(p, false, line);
        }
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
      diagnostics.push({ line: lineNo, severity: "error", message: e.message });
      failed = true;
      break;
    }
  }
  if (!failed && !ended) warn(lines.length, "Program has no M30 at the end");
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
