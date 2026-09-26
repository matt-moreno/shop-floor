import type { ReactNode } from "react";
import { holeCenters, type Feature } from "../game/features";
import type { StockSpec } from "../sim/stock";

const num = (n: number) => String(Math.round(n * 100) / 100);
const uniq = (vals: number[]) =>
  [...new Set(vals.map((v) => Math.round(v * 100) / 100))].sort(
    (a, b) => a - b,
  );
const DRILL_POINT = 0.6009; // height of a 118° point per unit radius

/** Spread label positions (screen units) so neighbours stay `gap` apart. */
function spread(at: number[], gap: number) {
  const order = at.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(at.length);
  let prev = -Infinity;
  for (const [v, i] of order) {
    prev = Math.max(v, prev + gap);
    out[i] = prev;
  }
  return out;
}

/**
 * Engineering-style drawing generated from a job's features: a top view
 * above a front view, with ordinate dimensions from work zero (the way
 * CNC drawings are usually dimensioned, since the numbers are coordinates).
 */
export function Drawing({
  stock,
  features,
}: {
  stock: StockSpec;
  features: Feature[];
}) {
  const { width: W, depth: D, height: H } = stock;
  const fs = Math.max(W, D) / 22;
  const ML = fs * 4.2,
    MR = fs * 4.6,
    MT = fs * 1.6,
    GAP = fs * 5.2,
    MB = fs * 1.4;
  const tx = ML,
    ty = MT;
  const fy = ty + D + GAP;
  const vbW = ML + W + MR;
  const vbH = fy + H + MB;
  // Work coords to SVG, for the top view (x, y) and front view (x, z).
  const T = (x: number, y: number) => [tx + x, ty + D - y] as const;
  const F = (x: number, z: number) => [tx + x, fy - z] as const;

  const xs = [0, W],
    ys = [0, D],
    zs = [0, -H];
  const top: ReactNode[] = [];
  const front: ReactNode[] = [];
  const centerLines: ReactNode[] = [];
  let silhouette: [number, number][] = [
    [0, 0],
    [W, 0],
  ];
  let faced = false;

  features.forEach((f, k) => {
    switch (f.kind) {
      case "face": {
        faced = true;
        zs.push(-f.depth);
        top.push(
          <rect key={k} x={tx} y={ty} width={W} height={D} className="cut" />,
        );
        silhouette = [
          [0, -f.depth],
          [W, -f.depth],
        ];
        break;
      }
      case "slot": {
        ys.push(f.y - f.width / 2, f.y + f.width / 2);
        zs.push(-f.depth);
        const [x, y] = T(f.x0, f.y + f.width / 2);
        top.push(
          <rect
            key={k}
            x={x}
            y={y}
            width={f.x1 - f.x0}
            height={f.width}
            className="cut"
          />,
        );
        front.push(
          <line
            key={k}
            x1={F(f.x0, 0)[0]}
            y1={F(0, -f.depth)[1]}
            x2={F(f.x1, 0)[0]}
            y2={F(0, -f.depth)[1]}
            className="hidden"
          />,
        );
        break;
      }
      case "pocket": {
        xs.push(f.x0, f.x1);
        ys.push(f.y0, f.y1);
        zs.push(-f.depth);
        const [x, y] = T(f.x0, f.y1);
        top.push(
          <rect
            key={k}
            x={x}
            y={y}
            width={f.x1 - f.x0}
            height={f.y1 - f.y0}
            rx={f.radius}
            className="cut"
          />,
        );
        const [a, b] = F(f.x0, 0);
        front.push(
          <rect
            key={k}
            x={a}
            y={b}
            width={f.x1 - f.x0}
            height={f.depth}
            className="hidden"
          />,
        );
        break;
      }
      case "holes": {
        xs.push(f.cx);
        ys.push(f.cy);
        zs.push(-f.depth);
        const [cx, cy] = T(f.cx, f.cy);
        centerLines.push(
          <circle
            key={`bc${k}`}
            cx={cx}
            cy={cy}
            r={f.bc / 2}
            className="center"
          />,
          crosshair(`c${k}`, cx, cy, fs * 1.2),
        );
        const r = f.dia / 2;
        for (const [n, c] of holeCenters(f).entries()) {
          const [hx, hy] = T(c.x, c.y);
          top.push(
            <circle
              key={`${k}-${n}`}
              cx={hx}
              cy={hy}
              r={r}
              className="cut deep"
            />,
          );
          centerLines.push(crosshair(`${k}-${n}`, hx, hy, r + fs * 0.5));
        }
        const full = f.depth - r * DRILL_POINT;
        for (const x of uniq(holeCenters(f).map((c) => c.x))) {
          const [l] = F(x - r, 0),
            [m] = F(x, 0),
            [rr] = F(x + r, 0);
          const [, top0] = F(0, 0),
            [, bot] = F(0, -full),
            [, tip] = F(0, -f.depth);
          front.push(
            <path
              key={`${k}f${x}`}
              d={`M${l} ${top0}V${bot}L${m} ${tip}L${rr} ${bot}V${top0}`}
              className="hidden"
            />,
          );
        }
        break;
      }
      case "boss": {
        xs.push(f.cx - f.dia / 2, f.cx, f.cx + f.dia / 2);
        ys.push(f.cy);
        zs.push(-f.height);
        top.push(
          <rect
            key={`${k}r`}
            x={tx}
            y={ty}
            width={W}
            height={D}
            className="cut"
          />,
        );
        const [cx, cy] = T(f.cx, f.cy);
        top.push(
          <circle key={k} cx={cx} cy={cy} r={f.dia / 2} className="stock" />,
        );
        centerLines.push(crosshair(`b${k}`, cx, cy, f.dia / 2 + fs));
        const r = f.dia / 2,
          h = -f.height;
        silhouette = [
          [0, h],
          [f.cx - r, h],
          [f.cx - r, 0],
          [f.cx + r, 0],
          [f.cx + r, h],
          [W, h],
        ];
        const [bx] = F(f.cx, 0);
        centerLines.push(
          <line
            key={`bf${k}`}
            x1={bx}
            y1={F(0, 0)[1] - fs}
            x2={bx}
            y2={F(0, -H)[1] + fs}
            className="center"
          />,
        );
        break;
      }
      case "plate": {
        xs.push(f.x0, f.x1);
        ys.push(f.y0, f.y1);
        zs.push(-f.height);
        top.push(
          <rect
            key={`${k}r`}
            x={tx}
            y={ty}
            width={W}
            height={D}
            className="cut"
          />,
        );
        const [x, y] = T(f.x0, f.y1);
        top.push(
          <rect
            key={k}
            x={x}
            y={y}
            width={f.x1 - f.x0}
            height={f.y1 - f.y0}
            rx={f.radius}
            className="stock"
          />,
        );
        const h = -f.height;
        silhouette = [
          [0, h],
          [f.x0, h],
          [f.x0, 0],
          [f.x1, 0],
          [f.x1, h],
          [W, h],
        ];
        break;
      }
      case "notch": {
        const r = f.width / 2;
        xs.push(f.x - r, f.x + r);
        ys.push(f.y - r, f.y);
        zs.push(-f.depth);
        const [l, back] = T(f.x - r, D),
          [, end] = T(0, f.y),
          [rr] = T(f.x + r, 0);
        top.push(
          <path
            key={k}
            d={`M${l} ${back}V${end}A${r} ${r} 0 0 0 ${rr} ${end}V${back}Z`}
            className="cut"
          />,
        );
        centerLines.push(crosshair(`n${k}`, ...T(f.x, f.y), r + fs * 0.5));
        const [a, b] = F(f.x - r, 0);
        front.push(
          <rect
            key={k}
            x={a}
            y={b}
            width={f.width}
            height={f.depth}
            className="hidden"
          />,
        );
        break;
      }
    }
  });

  const outline = [
    F(0, -H),
    F(W, -H),
    ...[...silhouette].reverse().map(([x, z]) => F(x, z)),
  ];

  return (
    <svg
      className="drawing"
      viewBox={`0 0 ${vbW} ${vbH}`}
      style={{ fontSize: fs }}
      role="img"
      aria-label="Part drawing"
    >
      {/* Top view */}
      <rect x={tx} y={ty} width={W} height={D} className="stock" />
      {top}
      <rect x={tx} y={ty} width={W} height={D} className="edge" />
      {centerLines}
      {workZero(...T(0, 0), fs)}
      {ordinates(
        uniq(xs).map((v) => T(v, 0)[0]),
        fs,
      ).map(([x, lx], k) => {
        const y = ty + D;
        const v = uniq(xs)[k];
        return (
          <g key={`x${v}`} className="dim">
            <polyline
              points={`${x},${y + fs * 0.4} ${x},${y + fs * 0.8} ${lx},${y + fs * 1.2} ${lx},${y + fs * 1.4}`}
            />
            <text
              x={lx + fs * 0.35}
              y={y + fs * 1.6}
              transform={`rotate(-90 ${lx + fs * 0.35} ${y + fs * 1.6})`}
              textAnchor="end"
            >
              {num(v)}
            </text>
          </g>
        );
      })}
      {ordinates(
        uniq(ys).map((v) => T(0, v)[1]),
        fs,
      ).map(([y, ly], k) => {
        const v = uniq(ys)[k];
        return (
          <g key={`y${v}`} className="dim">
            <polyline
              points={`${tx - fs * 0.4},${y} ${tx - fs * 0.8},${y} ${tx - fs * 1.2},${ly} ${tx - fs * 1.4},${ly}`}
            />
            <text x={tx - fs * 1.5} y={ly + fs * 0.35} textAnchor="end">
              {num(v)}
            </text>
          </g>
        );
      })}
      <text x={tx} y={ty - fs * 0.45} className="label">
        TOP
      </text>

      {/* Front view */}
      {faced && (
        <line
          x1={F(0, 0)[0]}
          y1={F(0, 0)[1]}
          x2={F(W, 0)[0]}
          y2={F(0, 0)[1]}
          className="phantom"
        />
      )}
      <polygon
        points={outline.map((p) => p.join(",")).join(" ")}
        className="stock edge"
      />
      {front}
      {ordinates(
        uniq(zs).map((v) => F(0, v)[1]),
        fs,
      ).map(([y, ly], k) => {
        const v = uniq(zs)[k];
        const x = tx + W;
        return (
          <g key={`z${v}`} className="dim">
            <polyline
              points={`${x + fs * 0.4},${y} ${x + fs * 0.8},${y} ${x + fs * 1.2},${ly} ${x + fs * 1.4},${ly}`}
            />
            <text x={x + fs * 1.5} y={ly + fs * 0.35}>
              Z{num(v)}
            </text>
          </g>
        );
      })}
      <text x={tx} y={fy + H + fs * 1.2} className="label">
        FRONT
      </text>
    </svg>
  );
}

/** Pair each dimension's true position with where its label goes. */
function ordinates(at: number[], fs: number): [number, number][] {
  const labels = spread(at, fs * 1.15);
  return at.map((v, i) => [v, labels[i]]);
}

function crosshair(key: string, x: number, y: number, r: number) {
  return (
    <path
      key={key}
      d={`M${x - r} ${y}H${x + r}M${x} ${y - r}V${y + r}`}
      className="center"
    />
  );
}

/** Datum symbol and axis arrows at work zero (front-left corner, top face). */
function workZero(x: number, y: number, fs: number) {
  const r = fs * 0.8,
    L = fs * 3.6;
  return (
    <g className="datum">
      <line
        x1={x}
        y1={y}
        x2={x + L}
        y2={y}
        className="ax-x"
        markerEnd="url(#arrow-x)"
      />
      <line
        x1={x}
        y1={y}
        x2={x}
        y2={y - L}
        className="ax-y"
        markerEnd="url(#arrow-y)"
      />
      <text x={x + L + fs * 0.3} y={y + fs * 0.35} className="ax-x-t">
        X
      </text>
      <text x={x + fs * 0.45} y={y - L + fs * 0.5} className="ax-y-t">
        Y
      </text>
      <circle cx={x} cy={y} r={r} className="datum-ring" />
      <path
        d={`M${x} ${y}H${x + r}A${r} ${r} 0 0 0 ${x} ${y - r}Z M${x} ${y}H${x - r}A${r} ${r} 0 0 0 ${x} ${y + r}Z`}
        className="datum-fill"
      />
      <defs>
        <marker
          id="arrow-x"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0 0L10 5L0 10Z" className="ax-x-t" />
        </marker>
        <marker
          id="arrow-y"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0 0L10 5L0 10Z" className="ax-y-t" />
        </marker>
      </defs>
    </g>
  );
}
