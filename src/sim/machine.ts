import { HOME, type Op, type Program, type Vec3 } from "./gcode";
import type { Heightmap } from "./stock";
import { getTool, type Tool } from "./tools";

export const RAPID_RATE = 12000; // mm/min
const TOOLCHANGE_SECONDS = 4;
const SPINDLE_RAMP_SECONDS = 1;

/** Stand-in for an empty spindle, so crashing it into the stock is detected. */
const SPINDLE_NOSE: Tool = {
  number: 0,
  name: "Spindle nose",
  tip: "flat",
  diameter: 40,
  flutes: 1,
  fluteLength: 1e6,
  maxDepthOfCut: 1e6,
  maxChipLoad: 1e6,
  color: "#444",
};

export type RunState =
  "idle" | "running" | "hold" | "stopped" | "done" | "alarm";

export interface Alarm {
  line: number;
  title: string;
  detail: string;
  crash: boolean;
}

export class Machine {
  state: RunState = "idle";
  pos: Vec3 = { ...HOME };
  tool: Tool | null = null;
  rpm = 0;
  coolant = false;
  opIndex = 0;
  private opProgress = 0;
  time = 0;
  toolChanges = 0;
  alarm: Alarm | null = null;
  /**
   * When set, alarms are recorded here and the run carries on, so one
   * verification pass finds every problem instead of just the first.
   */
  collectAlarms: Alarm[] | null = null;
  feedOverride = 1;
  rapidOverride = 1;
  singleBlock = false;
  /** Material removed in the last step (mm³), for sound and chips. */
  lastRemoved = 0;
  /** Bumped whenever something the UI shows changes. */
  version = 0;

  constructor(
    public program: Program,
    public stock: Heightmap,
    private initialTool: number | null = null,
  ) {
    this.reset();
  }

  get line() {
    return (
      this.program.ops[Math.min(this.opIndex, this.program.ops.length - 1)]
        ?.line ?? 0
    );
  }

  get currentFeed() {
    const op = this.program.ops[this.opIndex];
    if (this.state !== "running" || op?.kind !== "move") return 0;
    return op.rapid
      ? RAPID_RATE * this.rapidOverride
      : op.feed * this.feedOverride;
  }

  load(program: Program) {
    this.program = program;
    this.reset();
  }

  reset() {
    this.stock.reset();
    this.state = "idle";
    this.pos = { ...HOME };
    this.tool = this.initialTool ? (getTool(this.initialTool) ?? null) : null;
    this.rpm = 0;
    this.coolant = false;
    this.opIndex = 0;
    this.opProgress = 0;
    this.time = 0;
    this.toolChanges = 0;
    this.alarm = null;
    this.lastRemoved = 0;
    this.version++;
  }

  cycleStart() {
    if (this.state === "done" || this.state === "alarm") this.reset();
    if (this.program.ops.length === 0) return;
    this.state = "running";
    this.version++;
  }

  feedHold() {
    if (this.state === "running") {
      this.state = "hold";
      this.version++;
    }
  }

  /** Run the rest of the program with no animation. */
  finish() {
    if (this.state === "done" || this.state === "alarm") this.reset();
    this.state = "running";
    const saved = this.singleBlock;
    this.singleBlock = false;
    while (this.state === "running") this.step(3600);
    this.singleBlock = saved;
  }

  /** Advance simulated time by dt seconds. */
  step(dt: number) {
    this.lastRemoved = 0;
    if (this.state !== "running") return;
    let budget = dt;
    const ops = this.program.ops;
    while (budget > 1e-9 && this.state === "running") {
      const op = ops[this.opIndex];
      if (!op) {
        this.finishRun();
        break;
      }
      const used = this.advanceOp(op, budget);
      budget -= used;
      // Feed override at 0% holds motion without advancing the cycle clock.
      if (!(op.kind === "move" && !op.rapid && this.feedOverride === 0))
        this.time += used;
    }
    this.version++;
  }

  private nextOp() {
    const prev = this.program.ops[this.opIndex];
    this.opIndex++;
    this.opProgress = 0;
    const next = this.program.ops[this.opIndex];
    if (!next) this.finishRun();
    else if (this.singleBlock && prev && next.line !== prev.line)
      this.state = "stopped";
  }

  private finishRun() {
    this.state = "done";
    this.rpm = 0;
    this.coolant = false;
  }

  /** Returns the seconds consumed. */
  private advanceOp(op: Op, budget: number): number {
    switch (op.kind) {
      case "move":
        return this.advanceMove(op, budget);
      case "dwell":
      case "toolchange": {
        const total = op.kind === "dwell" ? op.seconds : TOOLCHANGE_SECONDS;
        const used = Math.min(budget, total - this.opProgress);
        this.opProgress += used;
        if (this.opProgress >= total - 1e-9) {
          if (op.kind === "toolchange") {
            this.tool = op.spec;
            this.toolChanges++;
          }
          this.nextOp();
        }
        return used;
      }
      case "spindle": {
        const ramp = op.rpm > 0 && this.rpm === 0 ? SPINDLE_RAMP_SECONDS : 0;
        const used = Math.min(budget, ramp - this.opProgress);
        this.opProgress += Math.max(0, used);
        if (this.opProgress >= ramp - 1e-9) {
          this.rpm = op.rpm;
          this.nextOp();
        }
        return Math.max(0, used);
      }
      case "coolant":
        this.coolant = op.on;
        this.nextOp();
        return 0;
      case "stop":
        this.nextOp();
        if (this.state === "running") this.state = "stopped";
        return 0;
      case "end":
        this.finishRun();
        return 0;
    }
  }

  private advanceMove(
    op: Extract<Op, { kind: "move" }>,
    budget: number,
  ): number {
    const { from, to } = op;
    const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const rate =
      (op.rapid
        ? RAPID_RATE * this.rapidOverride
        : op.feed * this.feedOverride) / 60;
    if (rate <= 0) return budget;
    const remaining = len - this.opProgress;
    const used = Math.min(budget, remaining / rate);
    const p0 = { ...this.pos };
    this.opProgress += used * rate;
    const t = len > 0 ? Math.min(1, this.opProgress / len) : 1;
    const p1 = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    };
    this.pos = p1;
    this.cutPiece(op, p0, p1);
    if (this.state === "running" && this.opProgress >= len - 1e-9) {
      this.pos = { ...to };
      this.nextOp();
    }
    return used;
  }

  private cutPiece(op: Extract<Op, { kind: "move" }>, a: Vec3, b: Vec3) {
    const tool = this.tool ?? SPINDLE_NOSE;
    const res = this.stock.cut(a, b, tool);
    const { width, depth, height } = this.stock.spec;
    const r = tool.diameter / 2;
    const overStock =
      b.x > -r && b.x < width + r && b.y > -r && b.y < depth + r;
    if (overStock && Math.min(a.z, b.z) < -height - 0.01) {
      return this.raise(
        op.line,
        true,
        "Crash: tool hit the vise",
        `The tool went below the bottom of the part (Z${(-height).toFixed(1)}) and hit the parallels.`,
      );
    }
    if (res.removed < 0.02) return;
    this.lastRemoved += res.removed;
    const T = `T${tool.number}`;
    if (!this.tool)
      return this.raise(
        op.line,
        true,
        "Crash: no tool loaded",
        "The spindle nose hit the stock. Load a tool with T# M6 first.",
      );
    if (op.rapid)
      return this.raise(
        op.line,
        true,
        "Crash: rapid move into the stock",
        "G0 moves at full speed and must never touch material. Use G1 with a feed rate to cut.",
      );
    if (this.rpm <= 0)
      return this.raise(
        op.line,
        true,
        "Crash: spindle not running",
        `${T} was fed into the stock with the spindle stopped. Start it with M3 S####.`,
      );
    if (res.holderOverlap > 0.05)
      return this.raise(
        op.line,
        true,
        "Crash: holder hit the stock",
        `${T} has ${tool.fluteLength} mm of flute, but the cut was ${(res.holderOverlap + tool.fluteLength).toFixed(1)} mm deep.`,
      );
    if (tool.tip === "drill" && res.engagement > 0.3)
      return this.raise(
        op.line,
        false,
        `${T} broke`,
        "Drills only cut straight down. Move XY only while clear of the part.",
      );
    if (res.engagement > tool.maxDepthOfCut + 0.05)
      return this.raise(
        op.line,
        false,
        `${T} broke`,
        `The cut was ${res.engagement.toFixed(2)} mm deep, but ${tool.name} can take at most ${tool.maxDepthOfCut} mm per pass. Step down in smaller passes.`,
      );
    const chip = (op.feed * this.feedOverride) / (this.rpm * tool.flutes);
    if (chip > tool.maxChipLoad * 1.25)
      return this.raise(
        op.line,
        false,
        `${T} broke`,
        `Feed per tooth was ${chip.toFixed(3)} mm, but ${tool.name} handles at most ${tool.maxChipLoad} mm. Lower F or raise S.`,
      );
  }

  private raise(line: number, crash: boolean, title: string, detail: string) {
    const list = this.collectAlarms;
    if (list) {
      const seen = list.some((a) => a.line === line && a.title === title);
      if (!seen && list.length < 20) list.push({ line, title, detail, crash });
      return;
    }
    this.alarm = { line, title, detail, crash };
    this.state = "alarm";
    this.rpm = 0;
  }
}
