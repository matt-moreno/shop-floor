import { useEffect, useState } from "react";
import { callout } from "../game/features";
import { jobRack, type Job } from "../game/jobs";
import { formatTime } from "./Controls";
import { Drawing } from "./Drawing";

export function Brief({ job, par }: { job: Job; par: number | null }) {
  const [enlarged, setEnlarged] = useState(false);
  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setEnlarged(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [enlarged]);
  const hasDrawing = job.features.length > 0;
  return (
    <div className="card brief">
      <h3>Work order</h3>
      <p className="summary">{job.summary}</p>
      {hasDrawing && (
        <button
          className="drawing-button"
          onClick={() => setEnlarged(true)}
          title="Enlarge drawing"
        >
          <Drawing stock={job.stock} features={job.features} />
          <span className="enlarge">⤢ Enlarge</span>
        </button>
      )}
      {hasDrawing && <Notes job={job} />}
      {enlarged && (
        <div className="drawing-modal" onClick={() => setEnlarged(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <header>
              <strong>{job.title}</strong>
              <span>{job.customer}</span>
              <button
                className="ghost small"
                onClick={() => setEnlarged(false)}
              >
                Close
              </button>
            </header>
            <Drawing stock={job.stock} features={job.features} />
            <Notes job={job} />
          </div>
        </div>
      )}
      <ul className="spec">
        {job.spec.map((s) => (
          <li key={s}>{s}</li>
        ))}
        {par !== null && <li>Par time {formatTime(par)}</li>}
      </ul>
      <h4>Tips</h4>
      <ul className="tips">
        {job.tips.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <h4>Tool rack</h4>
      <table className="tools">
        <thead>
          <tr>
            <th>T</th>
            <th>Tool</th>
            <th title="Flutes">Fl</th>
            <th title="Max depth of cut per pass (mm)">DOC</th>
            <th title="Max feed per tooth (mm)">Chip</th>
          </tr>
        </thead>
        <tbody>
          {jobRack(job).map((t) => {
            return (
              <tr key={t.number}>
                <td>T{t.number}</td>
                <td>{t.name}</td>
                <td>{t.flutes}</td>
                <td>{t.tip === "drill" ? "—" : t.maxDepthOfCut}</td>
                <td>{t.maxChipLoad}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ job }: { job: Job }) {
  const { width, depth, height } = job.stock;
  return (
    <div className="notes">
      <ol>
        {job.features.map((f, k) => (
          <li key={k}>{callout(f)}</li>
        ))}
      </ol>
      <p>
        Stock {width} × {depth} × {height} aluminum. All dimensions mm, ±0.1
        unless noted. Dimensions are coordinates from work zero{" "}
        <span className="datum-inline" aria-hidden /> (front-left corner, top
        face).
      </p>
    </div>
  );
}
