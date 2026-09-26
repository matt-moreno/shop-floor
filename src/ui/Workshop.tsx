import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jobTarget, type Job } from "../game/jobs";
import { interpret } from "../sim/gcode";
import { Machine, type RunState } from "../sim/machine";
import { compare, grade, type Comparison, type Grade } from "../sim/score";
import { Heightmap } from "../sim/stock";
import { SceneView, type ViewPreset } from "../view/scene";
import { Sound } from "../view/sound";
import { Brief } from "./Brief";
import { Controls } from "./Controls";
import { Editor, type Mark } from "./Editor";
import { Results } from "./Results";

export interface RunResult {
  comparison: Comparison;
  grade: Grade;
  time: number;
  par: number;
}

interface Props {
  job: Job;
  initialSource: string;
  best: number;
  hasNext: boolean;
  onSave: (source: string) => void;
  onStars: (stars: number) => void;
  onExit: () => void;
  onNext: () => void;
}

const SPEEDS = [1, 4, 16, 64];

export function Workshop({
  job,
  initialSource,
  best,
  hasNext,
  onSave,
  onStars,
  onExit,
  onNext,
}: Props) {
  const [source, setSource] = useState(initialSource);
  const program = useMemo(() => interpret(source), [source]);
  const target = useMemo(() => (job.sandbox ? null : jobTarget(job)), [job]);
  const machine = useMemo(
    () => new Machine(program, new Heightmap(job.stock)),
    [job],
  );
  const viewHost = useRef<HTMLDivElement>(null);
  const view = useRef<SceneView>(null);
  const sound = useRef(new Sound());
  const [, setTick] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [showPath, setShowPath] = useState(true);
  const [compareMode, setCompareMode] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const settle = useCallback(() => {
    if (machine.state === "done" && target) {
      const comparison = compare(machine.stock, target.target);
      const g = grade(comparison, machine.time, target.par);
      setResult({ comparison, grade: g, time: machine.time, par: target.par });
      if (g.passed) onStars(g.stars);
      setCompareMode(true);
    }
    setTick((t) => t + 1);
  }, [machine, target, onStars]);
  const settleRef = useRef(settle);
  settleRef.current = settle;

  // One render loop for simulation and drawing; React only hears about it
  // a few times a second, or when the run state changes.
  useEffect(() => {
    let lastState: RunState = machine.state;
    let lastUi = 0;
    const v = new SceneView(viewHost.current!, machine, (dt) => {
      machine.step(dt * speedRef.current);
      sound.current.update(
        machine.rpm,
        machine.lastRemoved / Math.max(dt, 1e-3) / 60,
        dt,
      );
      const now = performance.now();
      if (machine.state !== lastState) {
        lastState = machine.state;
        settleRef.current();
      } else if (now - lastUi > 80) {
        lastUi = now;
        setTick((t) => t + 1);
      }
    });
    if (target) v.setMachine(machine, target.target);
    view.current = v;
    return () => v.dispose();
  }, [machine, target]);

  // A fresh program loads onto fresh stock whenever the machine is idle.
  useEffect(() => {
    if (["idle", "done", "alarm"].includes(machine.state)) {
      machine.load(program);
      setResult(null);
      setCompareMode(false);
    }
    view.current?.setProgram(program);
  }, [program, machine]);

  useEffect(() => {
    const t = setTimeout(() => onSave(source), 400);
    return () => clearTimeout(t);
  }, [source, onSave]);

  useEffect(() => {
    if (!view.current) return;
    view.current.showPath = showPath;
  }, [showPath]);

  useEffect(() => {
    if (!view.current) return;
    view.current.compareMode = compareMode;
    view.current.redrawColors();
  }, [compareMode]);

  const act = useCallback(
    (fn: () => void) => {
      fn();
      if (machine.state === "idle") {
        setResult(null);
        setCompareMode(false);
      }
      settle();
    },
    [machine, settle],
  );
  const start = useCallback(() => {
    if (program.failed) return;
    if (machine.state === "done" || machine.state === "alarm") setResult(null);
    act(() => machine.cycleStart());
  }, [act, machine, program.failed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        start();
      } else if (e.key === "Escape") act(() => machine.feedHold());
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [start, act, machine]);

  const busy =
    machine.state === "running" ||
    machine.state === "hold" ||
    machine.state === "stopped";
  const mark: Mark = machine.alarm
    ? { line: machine.alarm.line, kind: "alarm" }
    : busy
      ? { line: machine.line, kind: "run" }
      : null;
  const errors = program.diagnostics.filter((d) => d.severity === "error");
  const warnings = program.diagnostics.filter((d) => d.severity === "warning");

  return (
    <div className="workshop">
      <header className="topbar">
        <button className="ghost" onClick={onExit}>
          ← Jobs
        </button>
        <div className="title">
          <strong>{job.title}</strong>
          <span>{job.customer}</span>
        </div>
        {!job.sandbox && <div className="stars small">{starString(best)}</div>}
        <div className={`status status-${machine.state}`}>
          {STATUS[machine.state]}
        </div>
      </header>

      <section className="program">
        <div className="panel-head">
          <span>Program</span>
          <span className="spacer" />
          {errors.length > 0 && (
            <span className="pill err">{errors.length} error</span>
          )}
          {warnings.length > 0 && (
            <span className="pill warn">
              {warnings.length} warning{warnings.length > 1 ? "s" : ""}
            </span>
          )}
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => {
              if (confirm("Replace your program with the starter program?"))
                setSource(job.starter);
            }}
          >
            Revert
          </button>
        </div>
        <Editor
          value={source}
          onChange={setSource}
          readOnly={busy}
          diagnostics={program.diagnostics}
          mark={mark}
        />
        {program.diagnostics.length > 0 && (
          <ul className="diagnostics">
            {program.diagnostics.slice(0, 6).map((d, k) => (
              <li key={k} className={d.severity}>
                <b>Line {d.line}</b> {d.message}
              </li>
            ))}
          </ul>
        )}
        {busy && (
          <div className="locked">
            Editing is locked while a program is running. Reset to edit.
          </div>
        )}
      </section>

      <main className="viewport">
        <div className="canvas-host" ref={viewHost} />
        <div className="view-tools">
          {(["iso", "top", "front"] as ViewPreset[]).map((p) => (
            <button
              key={p}
              className="chip"
              onClick={() => view.current?.fitCamera(p)}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
          <span className="sep" />
          <button
            className={`chip ${showPath ? "on" : ""}`}
            onClick={() => setShowPath(!showPath)}
          >
            Toolpath
          </button>
          {target && (
            <button
              className={`chip ${compareMode ? "on" : ""}`}
              onClick={() => setCompareMode(!compareMode)}
            >
              Compare
            </button>
          )}
          <button
            className={`chip ${soundOn ? "on" : ""}`}
            onClick={() => {
              if (soundOn) sound.current.disable();
              else sound.current.enable();
              setSoundOn(!soundOn);
            }}
          >
            Sound
          </button>
        </div>
        {compareMode && (
          <div className="legend">
            <span>
              <i style={{ background: "#5fbf7a" }} />
              In tolerance
            </span>
            <span>
              <i style={{ background: "#4f8fe0" }} />
              Material left
            </span>
            <span>
              <i style={{ background: "#e0524f" }} />
              Cut too deep
            </span>
          </div>
        )}
        {machine.alarm && (
          <div className={`alarm ${machine.alarm.crash ? "crash" : ""}`}>
            <strong>{machine.alarm.title}</strong>
            <span>
              Line {machine.alarm.line}: {machine.alarm.detail}
            </span>
          </div>
        )}
        {errors.length > 0 && !machine.alarm && (
          <div className="alarm">
            <strong>Program error</strong>
            <span>
              Line {errors[0].line}: {errors[0].message}
            </span>
          </div>
        )}
        {result && (
          <Results
            result={result}
            hasNext={hasNext}
            onClose={() => setResult(null)}
            onRetry={() => act(() => machine.reset())}
            onNext={onNext}
          />
        )}
      </main>

      <aside className="side">
        <Controls
          machine={machine}
          canStart={!program.failed && program.ops.length > 0}
          speed={speed}
          speeds={SPEEDS}
          onSpeed={setSpeed}
          onStart={start}
          onHold={() => act(() => machine.feedHold())}
          onReset={() => act(() => machine.reset())}
          onFinish={() => {
            if (program.failed) return;
            act(() => machine.finish());
          }}
          onChange={() => setTick((t) => t + 1)}
        />
        <Brief
          job={job}
          target={target?.target ?? null}
          par={target?.par ?? null}
        />
      </aside>
    </div>
  );
}

const STATUS: Record<RunState, string> = {
  idle: "Ready",
  running: "Running",
  hold: "Feed hold",
  stopped: "Stopped · press Cycle Start",
  done: "Complete",
  alarm: "Alarm",
};

export function starString(n: number) {
  return "★★★".slice(0, n) + "☆☆☆".slice(0, 3 - n);
}
