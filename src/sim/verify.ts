import type { Diagnostic, Program } from "./gcode";
import { Machine, type Alarm } from "./machine";
import { Heightmap, type StockSpec } from "./stock";

export interface Verification {
  alarms: Alarm[];
  /** Estimated cycle time (s). */
  time: number;
}

/** Dry-run a program on scratch stock, like a CAM verify, without animation. */
export function verify(program: Program, stock: StockSpec): Verification {
  if (program.failed) return { alarms: [], time: 0 };
  const m = new Machine(program, new Heightmap(stock));
  m.collectAlarms = [];
  m.finish();
  return { alarms: m.collectAlarms, time: m.time };
}

export function alarmDiagnostics(v: Verification): Diagnostic[] {
  return v.alarms.map((a) => ({
    line: a.line,
    severity: "error",
    source: "verify",
    message: `${a.title}. ${a.detail}`,
  }));
}
