import { describe, expect, it } from "vitest";
import { holeCenters, nominalHeight } from "../game/features";
import { JOBS, jobRack, jobTarget } from "../game/jobs";
import { HOME, interpret, type Op } from "./gcode";
import { Machine } from "./machine";
import { compare, grade } from "./score";
import { Heightmap } from "./stock";
import { verify } from "./verify";
import { getTool } from "./tools";

const moves = (ops: Op[]) => ops.filter((o) => o.kind === "move");

describe("interpreter", () => {
  it("reads linear moves, modes and comments", () => {
    const p = interpret(
      "G21 G90 (hi)\nG0 X10 Y5 ; go\nG1 Z-1 F100\nG91 G1 X5\nM30",
    );
    expect(p.failed).toBe(false);
    const m = moves(p.ops);
    expect(m.map((o) => o.to)).toEqual([
      { x: 10, y: 5, z: HOME.z },
      { x: 10, y: 5, z: -1 },
      { x: 15, y: 5, z: -1 },
    ]);
    expect(m[0].rapid).toBe(true);
    expect(m[1].feed).toBe(100);
  });

  it("converts inches", () => {
    const p = interpret("G20 G0 X1\nM30");
    expect(moves(p.ops)[0].to.x).toBeCloseTo(25.4);
  });

  it("errors on feed moves without F and stops there", () => {
    const p = interpret("G1 X10\nG0 X20\nM30");
    expect(p.failed).toBe(true);
    expect(p.diagnostics[0]).toMatchObject({ line: 1, severity: "error" });
    expect(moves(p.ops)).toHaveLength(0);
  });

  it("errors on unreadable text", () => {
    expect(interpret("G0 X10 hello").diagnostics[0].message).toMatch(
      /Can't read/,
    );
  });

  it("tessellates a full IJ circle that ends where it started", () => {
    const p = interpret("G0 X10 Y0 Z0\nG2 X10 Y0 I-10 J0 F100\nM30");
    const m = moves(p.ops).slice(1);
    expect(m.length).toBeGreaterThan(20);
    for (const o of m) expect(Math.hypot(o.to.x, o.to.y)).toBeCloseTo(10, 3);
    // Clockwise from 3 o'clock goes down through -Y first.
    expect(m[2].to.y).toBeLessThan(0);
    expect(m.at(-1)!.to).toEqual({ x: 10, y: 0, z: 0 });
  });

  it("handles R-format arcs and rejects mismatched ends", () => {
    const p = interpret("G0 X0 Y0 Z0\nG3 X20 Y0 R10 F100\nM30");
    const mid = moves(p.ops)[Math.floor(moves(p.ops).length / 2)];
    expect(mid.to.y).toBeLessThan(-9); // CCW from left to right passes below
    expect(interpret("G0 X0 Y0\nG2 X20 Y0 I5 J0 F100").failed).toBe(true);
  });

  it("expands peck drilling cycles and repeats them per XY line", () => {
    const p = interpret("G0 X0 Y0 Z10\nG98 G83 Z-6 R2 Q3 F100\nX10\nG80\nM30");
    const m = moves(p.ops);
    const feeds = m.filter((o) => !o.rapid);
    expect(feeds.map((o) => o.to.z)).toEqual([-1, -4, -6, -1, -4, -6]);
    expect(m.at(-1)!.to).toEqual({ x: 10, y: 0, z: 10 });
  });

  it("retracts to Z home on a tool change", () => {
    const p = interpret("G0 Z5\nT2 M6\nM30");
    expect(moves(p.ops).at(-1)!.to.z).toBe(HOME.z);
    expect(p.ops.some((o) => o.kind === "toolchange" && o.tool === 2)).toBe(
      true,
    );
  });

  it("rejects moves past machine travel", () => {
    expect(interpret("G0 X900").diagnostics[0].message).toMatch(/travel/);
  });
});

describe("stock", () => {
  it("cuts a flat slot of the tool's width", () => {
    const h = new Heightmap({ width: 40, depth: 20, height: 10 }, 160);
    h.cut({ x: -10, y: 10, z: -2 }, { x: 50, y: 10, z: -2 }, getTool(2)!);
    expect(h.heightAt(20, 10)).toBeCloseTo(-2);
    expect(h.heightAt(20, 14.6)).toBeCloseTo(-2);
    expect(h.heightAt(20, 15.6)).toBe(0);
  });

  it("leaves a rounded groove with a ball mill", () => {
    const h = new Heightmap({ width: 40, depth: 20, height: 10 }, 160);
    h.cut({ x: -10, y: 10, z: -3 }, { x: 50, y: 10, z: -3 }, getTool(4)!);
    expect(h.heightAt(20, 10)).toBeCloseTo(-3, 1);
    expect(h.heightAt(20, 12)).toBeGreaterThan(-3);
    expect(h.heightAt(20, 12)).toBeLessThan(-0.5);
  });

  it("never cuts below the bottom of the stock", () => {
    const h = new Heightmap({ width: 20, depth: 20, height: 5 }, 40);
    h.cut({ x: 10, y: 10, z: 5 }, { x: 10, y: 10, z: -20 }, getTool(2)!, true);
    expect(h.heightAt(10, 10)).toBe(-5);
  });
});

function run(src: string, stock = { width: 60, depth: 40, height: 10 }) {
  const m = new Machine(interpret(src), new Heightmap(stock, 120));
  m.finish();
  return m;
}

describe("machine", () => {
  const start = "G21 G90\nT2 M6\nS8000 M3\nG0 X-8 Y20\nG0 Z2\n";

  it("runs a clean program to the end", () => {
    const m = run(start + "G1 Z-2 F300\nG1 X70 F1000\nG0 Z60\nM30");
    expect(m.state).toBe("done");
    expect(m.alarm).toBeNull();
    expect(m.stock.heightAt(30, 20)).toBeCloseTo(-2);
    expect(m.time).toBeGreaterThan(4);
  });

  it("crashes on a rapid into the stock", () => {
    const m = run(start + "G0 Z-2\nG0 X70\nM30");
    expect(m.alarm).toMatchObject({ crash: true, line: 7 });
    expect(m.alarm!.title).toMatch(/rapid/);
  });

  it("crashes with the spindle off", () => {
    const m = run("G21\nT2 M6\nG0 X-8 Y20 Z-2\nG1 X70 F500\nM30");
    expect(m.alarm!.title).toMatch(/spindle/);
  });

  it("crashes with no tool loaded", () => {
    const m = run("G0 X30 Y20 Z5\nG1 Z-1 F100\nM30");
    expect(m.alarm!.title).toMatch(/no tool/);
  });

  it("breaks a tool that cuts too deep", () => {
    const m = run(start + "G1 Z-6 F300\nG1 X70 F1000\nM30");
    expect(m.alarm).toMatchObject({ crash: false });
    expect(m.alarm!.detail).toMatch(/5 mm per pass/);
  });

  it("breaks a tool that is fed too hard", () => {
    const m = run(start + "G1 Z-2 F300\nG1 X70 F5000\nM30");
    expect(m.alarm!.detail).toMatch(/per tooth/);
  });

  it("breaks a drill moved sideways in the part", () => {
    const m = run(
      "G21\nT5 M6\nS2500 M3\nG0 X30 Y20 Z2\nG1 Z-3 F200\nG1 X40\nM30",
    );
    expect(m.alarm!.detail).toMatch(/Drills/);
  });

  it("stops after each line in single block mode", () => {
    const m = new Machine(
      interpret(start + "G1 Z-2 F300\nM30"),
      new Heightmap({ width: 60, depth: 40, height: 10 }, 60),
    );
    m.singleBlock = true;
    m.cycleStart();
    m.step(100);
    expect(m.state).toBe("stopped");
    expect(m.line).toBe(3);
  });

  it("holds and resumes", () => {
    const m = new Machine(
      interpret(start + "G1 Z-2 F300\nG1 X70 F100\nM30"),
      new Heightmap({ width: 60, depth: 40, height: 10 }, 60),
    );
    m.cycleStart();
    m.step(10);
    m.feedHold();
    const t = m.time;
    m.step(10);
    expect(m.time).toBe(t);
    m.cycleStart();
    m.step(1000);
    expect(m.state).toBe("done");
  });
});

describe("cutter compensation", () => {
  const head = "G21 G90 G17\nT2 M6\nS8000 M3\nG0 X-20 Y-20 Z-1 F500\n";
  // A 20 mm square from X10 Y10, clockwise, G41 keeps the tool outside.
  const square =
    "G41 D2 G1 X10 Y10 F500\nY30\nX30\nY10\nX10\nG40 G1 X-20 Y-20\nM30";
  const path = (src: string) =>
    moves(interpret(src).ops)
      .filter((o) => !o.rapid)
      .map((o) => o.to);
  const near = (a: { x: number; y: number }, x: number, y: number) =>
    Math.hypot(a.x - x, a.y - y) < 1e-3;

  it("offsets straight edges by the tool radius and rolls around outside corners", () => {
    const p = interpret(head + square);
    expect(p.failed).toBe(false);
    const pts = path(head + square);
    // Lead-in lands square to the first edge, left of travel.
    expect(near(pts[0], 5, 10)).toBe(true);
    expect(pts.some((q) => near(q, 5, 30))).toBe(true);
    expect(pts.some((q) => near(q, 10, 35))).toBe(true);
    // Every point on the corner roll is one radius from the part corner.
    const roll = pts.filter((q) => q.x < 10 && q.y > 30);
    expect(roll.length).toBeGreaterThan(3);
    for (const q of roll)
      expect(Math.hypot(q.x - 10, q.y - 30)).toBeCloseTo(5, 3);
  });

  it("stops at the crossing point on inside corners", () => {
    // Counterclockwise inside a pocket with G41 keeps the tool inside.
    const src =
      head.replace("X-20 Y-20", "X20 Y20") +
      "G41 D2 G1 X20 Y10\nX30\nY30\nX10\nY10\nX20\nG40 G1 X20 Y20\nM30";
    const pts = path(src);
    for (const [x, y] of [
      [25, 15],
      [25, 25],
      [15, 25],
      [15, 15],
    ])
      expect(
        pts.some((q) => near(q, x, y)),
        `X${x} Y${y}`,
      ).toBe(true);
    expect(pts.every((q) => q.x >= 15 - 1e-3 && q.x <= 25 + 1e-3)).toBe(true);
  });

  it("cuts the part to the programmed size", () => {
    const m = run(head + square, { width: 40, depth: 40, height: 10 });
    expect(m.alarm).toBeNull();
    expect(m.stock.heightAt(10.2, 20)).toBe(0);
    expect(m.stock.heightAt(9.8, 20)).toBeCloseTo(-1);
    expect(m.stock.heightAt(20, 30.2)).toBeCloseTo(-1);
  });

  it("offsets arcs by growing or shrinking their radius", () => {
    // Clockwise full circle, tool outside: R10 part, R15 tool path.
    const src =
      head + "G41 D2 G1 X10 Y20\nG2 X10 Y20 I10 J0\nG40 G1 X-20 Y20\nM30";
    const arc = path(src).slice(1, -1);
    expect(arc.length).toBeGreaterThan(20);
    for (const q of arc)
      expect(Math.hypot(q.x - 20, q.y - 20)).toBeCloseTo(15, 3);
  });

  it("alarms when the tool is too big for an inside arc", () => {
    const src =
      head.replace("X-20 Y-20", "X20 Y0") +
      "G41 D2 G1 X15 Y0\nY20\nG3 X25 Y20 R5\nG1 Y0\nG40 G1 X20 Y-10\nM30";
    const p = interpret(src);
    expect(p.failed).toBe(true);
    expect(p.diagnostics[0]).toMatchObject({ line: 7 });
    expect(p.diagnostics[0].message).toMatch(/smaller cutter/);
    expect(interpret(src.replace("D2", "D3").replace("T2", "T3")).failed).toBe(
      false,
    );
  });

  it("alarms when an inside corner is too tight", () => {
    // A 6 mm slot-shaped pocket is narrower than the Ø10 tool.
    const src =
      head.replace("X-20 Y-20", "X20 Y20") +
      "G41 D2 G1 X20 Y17\nX30\nY23\nX10\nY17\nX20\nG40 G1 X20 Y20\nM30";
    expect(interpret(src).diagnostics[0].message).toMatch(
      /Cutter compensation/,
    );
  });

  it("moves to the programmed point on the G40 line, like a real control", () => {
    const src = head + square.replace("G40 G1 X-20 Y-20", "G40 G0 Z20");
    const last = moves(interpret(src).ops).at(-1)!;
    expect(last.from).toMatchObject({ x: 10, y: 5 });
    expect(last.to).toEqual({ x: 10, y: 10, z: 20 });
  });

  it("uses G10 L12 radius offsets", () => {
    const pts = path(head + "G10 L12 P2 R4.5\n" + square);
    expect(near(pts[0], 5.5, 10)).toBe(true);
  });

  it("holds Z moves until the corner ahead is known", () => {
    const src =
      "G21 G90\nT2 M6\nS8000 M3\nG0 X-20 Y10 Z5\nG41 D2 G1 X0 Y10 F500\nZ-1\nX30\nG40 G1 X50\nM30";
    const m = moves(interpret(src).ops);
    const plunge = m.find((o) => o.to.z === -1)!;
    expect(plunge.from.y).toBeCloseTo(15);
    expect(plunge.to.x).toBeCloseTo(0);
  });

  it("needs a D word, G17 and a straight lead-in", () => {
    expect(interpret("G41 G1 X10 F100").diagnostics[0].message).toMatch(
      /D word/,
    );
    expect(interpret("G18 G41 D2").diagnostics[0].message).toMatch(/G17/);
    const arcIn = interpret("T2 M6\nG0 X0 Y0 Z0\nG41 D2 G2 X10 Y0 R5 F100");
    expect(
      arcIn.diagnostics.find((d) => d.severity === "error")!.message,
    ).toMatch(/lead-in/);
  });

  it("warns when D doesn't match the loaded tool", () => {
    const p = interpret("T3 M6\nG0 X0 Y0\nG41 D2\nG40\nM30");
    expect(p.diagnostics.some((d) => /T3 is loaded/.test(d.message))).toBe(
      true,
    );
  });
});

describe("verify", () => {
  const stock = { width: 60, depth: 40, height: 10 };
  const start = "G21 G90\nT2 M6\nS8000 M3\nG0 X-8 Y20\nG0 Z2\n";

  it("finds every problem in one pass, one per line", () => {
    const v = verify(
      interpret(
        start + "G0 Z-2\nG0 X30\nG1 Z-9 F300\nG1 X70 F1000\nG0 Z60\nM30",
      ),
      stock,
    );
    expect(v.alarms.map((a) => [a.line, a.crash])).toEqual([
      [7, true], // rapid across into the stock
      [9, false], // 9 mm side cut breaks T2
    ]);
  });

  it("predicts the same cycle time as a real run", () => {
    const src = start + "G1 Z-2 F300\nG1 X70 F1000\nG0 Z60\nM30";
    const v = verify(interpret(src), stock);
    expect(v.alarms).toEqual([]);
    expect(v.time).toBeCloseTo(run(src).time, 6);
  });

  it("skips programs that don't parse", () => {
    expect(verify(interpret("G1 X10"), stock)).toEqual({ alarms: [], time: 0 });
  });
});

describe("jobs", () => {
  for (const job of JOBS) {
    it(`${job.title}: reference runs clean and earns 3 stars`, () => {
      const { target, par } = jobTarget(job);
      const m = new Machine(
        interpret(job.reference, { rack: jobRack(job) }),
        new Heightmap(job.stock),
      );
      m.finish();
      expect(m.alarm).toBeNull();
      expect(m.state).toBe("done");
      if (job.sandbox) return;
      const g = grade(compare(m.stock, target), m.time, par);
      expect(g).toMatchObject({ passed: true, stars: 3 });
    });

    if (!job.sandbox && job.starter !== job.reference)
      it(`${job.title}: the starter program doesn't pass yet`, () => {
        const { target, par } = jobTarget(job);
        const m = new Machine(
          interpret(job.starter, { rack: jobRack(job) }),
          new Heightmap(job.stock),
        );
        m.finish();
        expect(m.alarm).toBeNull();
        expect(grade(compare(m.stock, target), m.time, par).passed).toBe(false);
      });
  }

  for (const job of JOBS.filter((j) => !j.sandbox))
    it(`${job.title}: the drawing matches the reference part`, () => {
      const { target } = jobTarget(job);
      const { width, depth } = job.stock;
      let checked = 0;
      // Hole centers sit on a drill point, so grid rounding shows up as height.
      const check = (x: number, y: number, tol = 0.1) => {
        const z = nominalHeight(job.features, x, y);
        if (z === null) return;
        checked++;
        const at = `at X${x.toFixed(2)} Y${y.toFixed(2)}`;
        expect(Math.abs(target.heightAt(x, y) - z), at).toBeLessThan(tol);
      };
      for (let y = 0.7; y < depth; y += 1.3)
        for (let x = 0.7; x < width; x += 1.3) check(x, y);
      for (const f of job.features)
        if (f.kind === "holes")
          for (const c of holeCenters(f)) check(c.x, c.y, 0.15);
      expect(checked).toBeGreaterThan(500);
    });

  it("Bracket: the Ø10 cutter can't make the notch", () => {
    const job = JOBS.find((j) => j.id === "bracket")!;
    const src = job.reference
      .replace("T3 M6", "T2 M6")
      .replace("D3", "D2")
      .replace("S10000", "S8000");
    const p = interpret(src, { rack: jobRack(job) });
    expect(p.failed).toBe(true);
    expect(p.diagnostics[0].message).toMatch(/R5 arc/);
  });

  it("Reground: the nominal offset leaves the plate oversize", () => {
    const job = JOBS.find((j) => j.id === "reground")!;
    const { target, par } = jobTarget(job);
    const m = new Machine(
      interpret(job.starter, { rack: jobRack(job) }),
      new Heightmap(job.stock),
    );
    m.finish();
    const c = compare(m.stock, target);
    expect(c.remaining).toBeGreaterThan(0.03);
    expect(c.gouged).toBe(0);
    expect(grade(c, m.time, par).passed).toBe(false);
  });

  it("sandbox demo runs clean", () => {
    const job = JOBS.find((j) => j.sandbox)!;
    const m = new Machine(
      interpret(job.starter, { rack: jobRack(job) }),
      new Heightmap(job.stock),
    );
    m.finish();
    expect(m.alarm).toBeNull();
  });

  it("flags gouges from a slot that is too deep", () => {
    const job = JOBS.find((j) => j.id === "slot")!;
    const { target, par } = jobTarget(job);
    const m = new Machine(
      interpret(job.reference.replace("Z-4", "Z-4.5")),
      new Heightmap(job.stock),
    );
    m.finish();
    const g = grade(compare(m.stock, target), m.time, par);
    expect(g.passed).toBe(false);
    expect(g.reasons.join()).toMatch(/too deep/);
  });
});
