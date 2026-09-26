import type { Machine } from "../sim/machine";

interface Props {
  machine: Machine;
  canStart: boolean;
  speed: number;
  speeds: number[];
  onSpeed: (s: number) => void;
  onStart: () => void;
  onHold: () => void;
  onReset: () => void;
  onFinish: () => void;
  onChange: () => void;
}

const RAPIDS = [0.05, 0.25, 0.5, 1];

export function Controls({
  machine: m,
  canStart,
  speed,
  speeds,
  onSpeed,
  onStart,
  onHold,
  onReset,
  onFinish,
  onChange,
}: Props) {
  const fmt = (n: number) => (n >= 0 ? " " : "") + n.toFixed(3);
  return (
    <div className="card controls">
      <div className="dro">
        {(["x", "y", "z"] as const).map((a) => (
          <div key={a} className="axis">
            <span>{a.toUpperCase()}</span>
            <output>{fmt(m.pos[a])}</output>
          </div>
        ))}
      </div>
      <div className="readouts">
        <div>
          <span>Tool</span>
          <b>{m.tool ? `T${m.tool.number}` : "—"}</b>
        </div>
        <div>
          <span>Spindle</span>
          <b>{Math.round(m.rpm)}</b>
        </div>
        <div>
          <span>Feed</span>
          <b>{Math.round(m.currentFeed)}</b>
        </div>
        <div>
          <span>Cycle</span>
          <b>{formatTime(m.time)}</b>
        </div>
      </div>
      <div className="buttons">
        <button
          className="btn start"
          disabled={!canStart || m.state === "running"}
          onClick={onStart}
        >
          Cycle Start
        </button>
        <button
          className="btn hold"
          disabled={m.state !== "running"}
          onClick={onHold}
        >
          Feed Hold
        </button>
        <button className="btn reset" onClick={onReset}>
          Reset
        </button>
      </div>
      <div className="row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={m.singleBlock}
            onChange={(e) => {
              m.singleBlock = e.target.checked;
              onChange();
            }}
          />
          Single block
        </label>
        <button
          className="ghost small"
          disabled={!canStart}
          onClick={onFinish}
          title="Run the whole program instantly"
        >
          Skip to end ⏭
        </button>
      </div>
      <div className="slider">
        <span>Feed override</span>
        <input
          type="range"
          min={0}
          max={200}
          step={10}
          value={Math.round(m.feedOverride * 100)}
          onChange={(e) => {
            m.feedOverride = Number(e.target.value) / 100;
            onChange();
          }}
        />
        <b>{Math.round(m.feedOverride * 100)}%</b>
      </div>
      <div className="seg-row">
        <span>Rapid</span>
        <div className="seg">
          {RAPIDS.map((r) => (
            <button
              key={r}
              className={m.rapidOverride === r ? "on" : ""}
              onClick={() => {
                m.rapidOverride = r;
                onChange();
              }}
            >
              {r * 100}%
            </button>
          ))}
        </div>
      </div>
      <div className="seg-row">
        <span>Sim speed</span>
        <div className="seg">
          {speeds.map((s) => (
            <button
              key={s}
              className={speed === s ? "on" : ""}
              onClick={() => onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
      <p className="hint">⌘/Ctrl + Enter starts · Esc holds</p>
    </div>
  );
}

export function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}
