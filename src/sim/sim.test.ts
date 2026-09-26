import { describe, expect, it } from "vitest";
import { JOBS, jobTarget } from "../game/jobs";
import { HOME, interpret, type Op } from "./gcode";
import { Machine } from "./machine";
import { compare, grade } from "./score";
import { Heightmap } from "./stock";
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

describe("jobs", () => {
  for (const job of JOBS) {
    it(`${job.title}: reference runs clean and earns 3 stars`, () => {
      const { target, par } = jobTarget(job);
      const m = new Machine(interpret(job.reference), new Heightmap(job.stock));
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
        const m = new Machine(interpret(job.starter), new Heightmap(job.stock));
        m.finish();
        expect(m.alarm).toBeNull();
        expect(grade(compare(m.stock, target), m.time, par).passed).toBe(false);
      });
  }

  it("sandbox demo runs clean", () => {
    const job = JOBS.find((j) => j.sandbox)!;
    const m = new Machine(interpret(job.starter), new Heightmap(job.stock));
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
