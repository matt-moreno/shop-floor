import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jobRack, jobTarget, type Job } from "../game/jobs";
import { interpret } from "../sim/gcode";
import { Machine, type RunState } from "../sim/machine";
import { compare, grade, type Comparison, type Grade } from "../sim/score";
import { Heightmap } from "../sim/stock";
import { alarmDiagnostics, verify, type Verification } from "../sim/verify";
import { SceneView, type ViewPreset } from "../view/scene";
import { Sound } from "../view/sound";
import { Brief } from "./Brief";
import { Controls, formatTime } from "./Controls";
import { Editor, type Jump, type Mark } from "./Editor";
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
  const rack = useMemo(() => jobRack(job), [job]);
  const program = useMemo(() => interpret(source, { rack }), [source, rack]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  // Dry-run the program shortly after typing stops, so predicted alarms
  // show on their lines before anything is run.
  useEffect(() => {
    setVerification(null);
    const t = setTimeout(
      () => setVerification(verify(program, job.stock)),
      300,
    );
    return () => clearTimeout(t);
  }, [program, job.stock]);
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
  const diagnostics = useMemo(
    () => [
      ...program.diagnostics,
      ...(verification ? alarmDiagnostics(verification) : []),
    ],
    [program, verification],
  );
  const goTo = (line: number) => setJump({ line, seq: (jump?.seq ?? 0) + 1 });

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
          diagnostics={diagnostics}
          mark={mark}
          jump={jump}
        />
        {diagnostics.length > 0 && (
          <ul className="diagnostics">
            {diagnostics.slice(0, 8).map((d, k) => (
              <li key={k} className={d.source ?? d.severity}>
                <button onClick={() => goTo(d.line)}>
                  <b>Line {d.line}</b>
                  {d.source === "verify" && <span className="tag">Verify</span>}
                  {d.message}
                </button>
              </li>
            ))}
          </ul>
        )}
        <VerifyBar
          program={program}
          verification={verification}
          par={target?.par ?? null}
          onGo={goTo}
        />
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
        <Brief job={job} par={target?.par ?? null} />
      </aside>
    </div>
  );
}

function VerifyBar({
  program,
  verification: v,
  par,
  onGo,
}: {
  program: ReturnType<typeof interpret>;
  verification: Verification | null;
  par: number | null;
  onGo: (line: number) => void;
}) {
  if (program.failed)
    return (
      <div className="verify-bar bad">Verify: fix the program error first</div>
    );
  if (!program.ops.length) return null;
  if (!v) return <div className="verify-bar">Verify: checking…</div>;
  const time = (
    <span className="est">
      est. cycle {formatTime(v.time)}
      {par !== null && ` · par ${formatTime(par)}`}
    </span>
  );
  if (!v.alarms.length)
    return (
      <div className="verify-bar ok">
        <span>✓ Verified: runs without alarms</span>
        {time}
      </div>
    );
  const crashes = v.alarms.filter((a) => a.crash).length;
  const breaks = v.alarms.length - crashes;
  const parts = [
    crashes && `${crashes} crash${crashes > 1 ? "es" : ""}`,
    breaks && `${breaks} broken tool${breaks > 1 ? "s" : ""}`,
  ].filter(Boolean);
  return (
    <div className="verify-bar bad">
      <button onClick={() => onGo(v.alarms[0].line)}>
        ✗ Verify predicts {parts.join(" and ")} · first on line{" "}
        {v.alarms[0].line}
      </button>
      {time}
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
