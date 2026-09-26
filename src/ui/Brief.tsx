import { useEffect, useRef } from "react";
import type { Job } from "../game/jobs";
import type { Heightmap } from "../sim/stock";
import { getTool } from "../sim/tools";
import { formatTime } from "./Controls";

export function Brief({
  job,
  target,
  par,
}: {
  job: Job;
  target: Heightmap | null;
  par: number | null;
}) {
  return (
    <div className="card brief">
      <h3>Work order</h3>
      <p className="summary">{job.summary}</p>
      {target && <TargetMap map={target} />}
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
          {job.tools.map((n) => {
            const t = getTool(n)!;
            return (
              <tr key={n}>
                <td>T{n}</td>
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

/** Top-down depth map of the finished part: the "drawing". */
function TargetMap({ map }: { map: Heightmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const { nx, ny, heights, spec } = map;
    c.width = nx;
    c.height = ny;
    const g = c.getContext("2d")!;
    const img = g.createImageData(nx, ny);
    let min = 0;
    for (const h of heights) min = Math.min(min, h);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const h = heights[j * nx + i];
        const t = min < 0 ? h / min : 0; // 0 top, 1 deepest
        const k = ((ny - 1 - j) * nx + i) * 4;
        img.data[k] = 190 - t * 150;
        img.data[k + 1] = 198 - t * 110;
        img.data[k + 2] = 206 - t * 40;
        img.data[k + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    c.style.aspectRatio = `${spec.width} / ${spec.depth}`;
  }, [map]);
  return (
    <figure className="target">
      <canvas ref={ref} />
      <figcaption>
        <span>Target, top view · darker is deeper</span>
        <span>
          {map.spec.width} × {map.spec.depth} mm
        </span>
      </figcaption>
    </figure>
  );
}
