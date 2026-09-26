import { interpret } from "../sim/gcode";
import { Machine } from "../sim/machine";
import { Heightmap, type StockSpec } from "../sim/stock";
import { makeRack } from "../sim/tools";
import type { Feature } from "./features";

export interface Job {
  id: string;
  title: string;
  customer: string;
  summary: string;
  /** Short lines shown in the brief. */
  spec: string[];
  tips: string[];
  tools: number[];
  /** Tools reground to a new actual diameter (mm), by tool number. */
  wear?: Record<number, number>;
  stock: StockSpec;
  /** Drawing features; empty for the sandbox. */
  features: Feature[];
  starter: string;
  reference: string;
  /** Sandbox jobs are never graded. */
  sandbox?: boolean;
}

const HEADER = "G21 G90 G17 (mm, absolute, XY plane)";

export const JOBS: Job[] = [
  {
    id: "first-chip",
    title: "First Chip",
    customer: "Training",
    summary: "Face 1 mm off the top of the block so it's flat and clean.",
    spec: [
      "Stock 80 × 50 × 20 mm, aluminum",
      "Face the top to Z-1.0",
      "Tool: T1 Ø50 face mill",
    ],
    tips: [
      "The program is already written. Read each line, then press Cycle Start.",
      "Work zero is the front-left corner of the top face. +X is right, +Y is away from you, +Z is up.",
      "G0 is a rapid move and must stay out of the metal. G1 cuts at the feed rate F (mm/min).",
    ],
    tools: [1],
    stock: { width: 80, depth: 50, height: 20 },
    features: [{ kind: "face", depth: 1 }],
    starter: `(JOB 1 - FIRST CHIP)
(Face 1 mm off the top of the block)
${HEADER}
T1 M6 (load the face mill)
S3000 M3 (spindle on, 3000 rpm)
G0 X-30 Y12 (rapid to the start, off the part)
G0 Z5
G1 Z-1 F600 (feed down to depth, still off the part)
G1 X110 F1500 (first pass across)
G0 Y38 (step over while clear of the part)
G1 X-30 (second pass back)
G0 Z60 (retract)
M30 (end of program)
`,
    reference: "",
  },
  {
    id: "slot",
    title: "Slot",
    customer: "Brightline Fixtures",
    summary: "Cut a 10 mm wide slot straight across the part.",
    spec: [
      "Stock 80 × 40 × 15 mm",
      "Slot runs the full length in X, centered at Y20",
      "Width 10 mm, depth 4 mm",
      "Tool: T2 Ø10 flat end mill",
    ],
    tips: [
      "A Ø10 cutter makes a 10 mm slot in one pass. Put the tool center on the slot's centerline.",
      "Start and finish off the part (X-8 and X88) so the tool enters and exits cleanly.",
      "Chip load = F ÷ (S × flutes). T2 has 3 flutes and handles up to 0.08 mm per tooth.",
    ],
    tools: [2],
    stock: { width: 80, depth: 40, height: 15 },
    features: [{ kind: "slot", x0: 0, x1: 80, y: 20, width: 10, depth: 4 }],
    starter: `(JOB 2 - SLOT)
${HEADER}
T2 M6
S8000 M3
G0 X-8 Y20
G0 Z5
(TODO: feed down to Z-4 at F300, cut to X88 at F1200, then retract)

M30
`,
    reference: `${HEADER}
T2 M6
S8000 M3
G0 X-8 Y20
G0 Z5
G1 Z-4 F300
G1 X88 F1200
G0 Z60
M30
`,
  },
  {
    id: "pocket",
    title: "Pocket",
    customer: "Kestrel Robotics",
    summary: "Mill a 40 × 30 mm pocket, 6 mm deep, in the middle of the block.",
    spec: [
      "Stock 80 × 60 × 20 mm",
      "Pocket X20–60, Y15–45, depth 6 mm",
      "R5 inside corners (the cutter leaves them)",
      "Tool: T2 Ø10 flat end mill, max 5 mm per pass",
    ],
    tips: [
      "The first 3 mm pass is written for you. Add a second pass at Z-6.",
      "Going straight to Z-6 breaks the tool: T2 can only cut 5 mm deep per pass.",
      "The tool center stays 5 mm inside the pocket walls: X25–55, Y20–40.",
    ],
    tools: [2],
    stock: { width: 80, depth: 60, height: 20 },
    features: [
      { kind: "pocket", x0: 20, y0: 15, x1: 60, y1: 45, depth: 6, radius: 5 },
    ],
    starter: `(JOB 3 - POCKET)
${HEADER}
T2 M6
S8000 M3
G0 X25 Y20
G0 Z2
(-- pass 1: Z-3 --)
G1 Z-3 F300
G1 X55 F1000
G1 Y28
G1 X25
G1 Y36
G1 X55
G1 Y40
G1 X25
(clean up the walls)
G1 Y20
G1 X55
G1 Y40
G1 X25
(-- pass 2: Z-6 --)
(TODO)

G0 Z60
M30
`,
    reference: `${HEADER}
T2 M6
S8000 M3
G0 X25 Y20
G0 Z2
G1 Z-3 F300
G1 X55 F1000
G1 Y28
G1 X25
G1 Y36
G1 X55
G1 Y40
G1 X25
G1 Y20
G1 X55
G1 Y40
G1 X25
G1 Z-6 F300
G1 Y20 F1000
G1 X55
G1 Y28
G1 X25
G1 Y36
G1 X55
G1 Y40
G1 X25
G1 Y20
G1 X55
G1 Y40
G1 X25
G0 Z60
M30
`,
  },
  {
    id: "bolt-circle",
    title: "Bolt Circle",
    customer: "Halvorsen Marine",
    summary: "Drill six holes evenly spaced on a Ø40 bolt circle.",
    spec: [
      "Stock 70 × 70 × 12 mm",
      "Bolt circle Ø40, centered at X35 Y35",
      "6 holes, Ø6, 10 mm deep, first hole at 3 o'clock",
      "Tool: T5 Ø6 drill",
    ],
    tips: [
      "G83 is a peck drilling cycle. It stays active, so each new X Y line drills another hole.",
      "Holes sit every 60°: X = 35 + 20·cos(θ), Y = 35 + 20·sin(θ).",
      "G80 cancels the cycle. Drills can't cut sideways, so never move XY while the drill is in the part.",
    ],
    tools: [5],
    stock: { width: 70, depth: 70, height: 12 },
    features: [
      {
        kind: "holes",
        cx: 35,
        cy: 35,
        bc: 40,
        count: 6,
        dia: 6,
        depth: 10,
        startDeg: 0,
      },
    ],
    starter: `(JOB 4 - BOLT CIRCLE)
${HEADER}
T5 M6
S2500 M3
G0 X55 Y35
G0 Z10
G98 G83 X55 Y35 Z-10 R2 Q3 F300 (hole 1 at 0 deg)
(TODO: holes 2-6)

G80
G0 Z60
M30
`,
    reference: `${HEADER}
T5 M6
S2500 M3
G0 X55 Y35
G0 Z10
G98 G83 X55 Y35 Z-10 R2 Q3 F300
X45 Y52.321
X25 Y52.321
X15 Y35
X25 Y17.679
X45 Y17.679
G80
G0 Z60
M30
`,
  },
  {
    id: "round-boss",
    title: "Round Boss",
    customer: "Oriel Optics",
    summary:
      "Leave a Ø40 round boss standing 5 mm tall; everything around it comes down.",
    spec: [
      "Stock 60 × 60 × 20 mm",
      "Boss Ø40, centered at X30 Y30, 5 mm tall",
      "Everything outside the boss cut to Z-5",
      "Tool: T2 Ø10 flat end mill",
    ],
    tips: [
      "G2 is a clockwise arc. I and J are the distance from the start point to the arc's center.",
      "Starting at X71 Y30, the center is 41 mm to the left: I-41 J0. Same start and end = full circle.",
      "Step in with smaller circles until the tool center reaches R25 (boss radius 20 + tool radius 5).",
    ],
    tools: [2],
    stock: { width: 60, depth: 60, height: 20 },
    features: [{ kind: "boss", cx: 30, cy: 30, dia: 40, height: 5 }],
    starter: `(JOB 5 - ROUND BOSS)
${HEADER}
T2 M6
S8000 M3
G0 X71 Y30
G0 Z2
G1 Z-5 F300
G2 X71 Y30 I-41 J0 F1000 (outer circle, R41)
(TODO: step in and finish at R25)

G0 Z60
M30
`,
    reference: `${HEADER}
T2 M6
S8000 M3
G0 X71 Y30
G0 Z2
G1 Z-5 F300
G2 X71 Y30 I-41 J0 F1000
G1 X63
G2 X63 Y30 I-33 J0
G1 X55
G2 X55 Y30 I-25 J0
G0 Z60
M30
`,
  },
  {
    id: "profile",
    title: "Profile",
    customer: "Aldine Instruments",
    summary:
      "Cut around a 60 × 40 plate with rounded corners, programming the part's edges straight off the drawing.",
    spec: [
      "Stock 70 × 50 × 15 mm",
      "Plate X5–65, Y5–45, R5 corners, 5 mm tall",
      "Everything outside the plate cut to Z-5",
      "Tool: T2 Ø10 flat end mill",
    ],
    tips: [
      "G41 turns on cutter compensation: the control keeps the tool one radius to the left of the path you program. You write the part's edges, not the tool center.",
      "D2 picks the offset. D registers hold each tool's radius, so D2 is 5 mm for T2. Going clockwise around the outside with G41 keeps the tool off the part.",
      "Corners are R5 arcs, like G2 X65 Y40 R5 from X60 Y45. Finish back at X5 Y10. G40 turns compensation off on the next move, which goes to the programmed point, so lead out sideways before retracting.",
    ],
    tools: [2],
    stock: { width: 70, depth: 50, height: 15 },
    features: [
      { kind: "plate", x0: 5, y0: 5, x1: 65, y1: 45, radius: 5, height: 5 },
    ],
    starter: `(JOB 6 - PROFILE)
${HEADER}
T2 M6
S8000 M3
G0 X-10 Y-10 (start off the part)
G0 Z2
G1 Z-5 F300 (plunge outside the stock)
G41 D2 G1 X5 Y10 F1000 (comp on: lead in to the left edge)
Y40 (left edge, in part coordinates)
G2 X10 Y45 R5 (top-left corner)
G1 X60 (top edge)
(TODO: top-right corner, right edge, bottom-right corner,)
(bottom edge, and the last corner back to X5 Y10)

G40 G1 X-10 Y10 (comp off: lead out to the left)
G0 Z60
M30
`,
    reference: `${HEADER}
T2 M6
S8000 M3
G0 X-10 Y-10
G0 Z2
G1 Z-5 F300
G41 D2 G1 X5 Y10 F1000
Y40
G2 X10 Y45 R5
G1 X60
G2 X65 Y40 R5
G1 Y10
G2 X60 Y5 R5
G1 X10
G2 X5 Y10 R5
G40 G1 X-10 Y10
G0 Z60
M30
`,
  },
  {
    id: "reground",
    title: "Reground",
    customer: "Pell & Sons Hydraulics",
    summary:
      "The program is proven, but T2 came back from the grinder smaller. Get the plate to size without touching the toolpath.",
    spec: [
      "Stock 64 × 44 × 12 mm",
      "Plate X4–60, Y4–40, R5 corners, 4 mm tall",
      "T2 was reground and measures Ø9.4",
      "The D2 offset still holds 5.0 (the new-tool radius)",
    ],
    tips: [
      "Run it as written and every edge comes out 0.3 mm oversize, because the control still thinks the cutter is Ø10.",
      "G10 L12 P2 R… writes a new radius into D2. Put it before the G41 line.",
      "This is why shops use cutter compensation: the program stays the same, and only the offset changes as tools wear.",
    ],
    tools: [2],
    wear: { 2: 9.4 },
    stock: { width: 64, depth: 44, height: 12 },
    features: [
      { kind: "plate", x0: 4, y0: 4, x1: 60, y1: 40, radius: 5, height: 4 },
    ],
    starter: `(JOB 7 - REGROUND)
${HEADER}
T2 M6
S8000 M3
G0 X-10 Y-10
G0 Z2
G1 Z-4 F300
G41 D2 G1 X4 Y9 F1000 (comp on, radius from D2)
Y35
G2 X9 Y40 R5
G1 X55
G2 X60 Y35 R5
G1 Y9
G2 X55 Y4 R5
G1 X9
G2 X4 Y9 R5
G40 G1 X-10 Y9 (comp off: lead out)
G0 Z60
M30
`,
    reference: `${HEADER}
G10 L12 P2 R4.7 (D2 = reground T2 radius)
T2 M6
S8000 M3
G0 X-10 Y-10
G0 Z2
G1 Z-4 F300
G41 D2 G1 X4 Y9 F1000 (comp on, radius from D2)
Y35
G2 X9 Y40 R5
G1 X55
G2 X60 Y35 R5
G1 Y9
G2 X55 Y4 R5
G1 X9
G2 X4 Y9 R5
G40 G1 X-10 Y9 (comp off: lead out)
G0 Z60
M30
`,
  },
  {
    id: "bracket",
    title: "Bracket",
    customer: "Tamsin Cycles",
    summary:
      "Profile a bracket with a round-ended notch in the back edge. Pick a cutter that fits it.",
    spec: [
      "Stock 64 × 44 × 10 mm",
      "Plate X2–62, Y2–42, R4 corners, 3 mm tall",
      "Notch 10 wide at X32, full R5 end centered at Y31",
      "Tools: T2 Ø10 or T3 Ø6 flat end mill",
    ],
    tips: [
      "The notch goes down the wall at X27 to Y31, around the end with G3 X37 Y31 R5, and back up at X37.",
      "With compensation on, the tool center runs the notch end at R5 minus the tool radius. For T2 that's zero, so the control stops with an overcut alarm.",
      "T3 fits with room to spare. Use D3 for its radius, and mind T3's chip load: F ÷ (S × 3) at most 0.05.",
    ],
    tools: [2, 3],
    stock: { width: 64, depth: 44, height: 10 },
    features: [
      { kind: "plate", x0: 2, y0: 2, x1: 62, y1: 42, radius: 4, height: 3 },
      { kind: "notch", x: 32, y: 31, width: 10, depth: 3 },
    ],
    starter: `(JOB 8 - BRACKET)
${HEADER}
T2 M6
S8000 M3
G0 X-8 Y-8
G0 Z2
G1 Z-3 F300
G41 D2 G1 X2 Y6 F1000
Y38
G2 X6 Y42 R4
G1 X58 (TODO: the notch, between X27 and X37)
G2 X62 Y38 R4
G1 Y6
G2 X58 Y2 R4
G1 X6
G2 X2 Y6 R4
G40 G1 X-8 Y6
G0 Z60
M30
`,
    reference: `${HEADER}
T3 M6
S10000 M3
G0 X-8 Y-8
G0 Z2
G1 Z-3 F300
G41 D3 G1 X2 Y6 F900
Y38
G2 X6 Y42 R4
G1 X27
Y31
G3 X37 Y31 R5
G1 Y42
X58
G2 X62 Y38 R4
G1 Y6
G2 X58 Y2 R4
G1 X6
G2 X2 Y6 R4
G40 G1 X-8 Y6
G0 Z60
M30
`,
  },
  {
    id: "sandbox",
    title: "Sandbox",
    customer: "Your shop",
    summary:
      "A 100 × 80 × 30 block and the whole tool rack. No grading, just cutting.",
    spec: ["Stock 100 × 80 × 30 mm", "All tools available"],
    tips: [
      "Try the ball end mill (T4) with a sloped G1 or G2 move for a 3D surface.",
      "Supported: G0 G1 G2 G3 G4 G10 L12 G17-19 G20/21 G28 G40-42 G73 G80-83 G90/91 G98/99, M0 M3 M4 M5 M6 M8 M9 M30.",
    ],
    tools: [1, 2, 3, 4, 5, 6],
    stock: { width: 100, depth: 80, height: 30 },
    features: [],
    sandbox: true,
    starter: `(SANDBOX - a little demo)
${HEADER}
T1 M6
S3000 M3
G0 X-30 Y15 Z5
G1 Z-1 F600
G1 X130 F1500
G0 Y55
G1 X-30
G0 Z60
T4 M6 (ball end mill)
S10000 M3
G0 X20 Y40 Z2
G1 Z-2 F400
G2 X80 Y40 I30 J0 Z-2.8 F1200
G2 X20 Y40 I-30 J0 Z-2
G0 Z60
T5 M6
S2500 M3
G0 X50 Y40 Z10
G98 G83 Z-12 R2 Q3 F300
G80
G0 Z60
M30
`,
    reference: "",
  },
];
JOBS[0].reference = JOBS[0].starter;

/** The tools this job's machine is loaded with, wear included. */
export function jobRack(job: Job) {
  return makeRack(job.tools, job.wear);
}

export interface JobTarget {
  target: Heightmap;
  par: number;
}

const targets = new Map<string, JobTarget>();

export function jobTarget(job: Job): JobTarget {
  let t = targets.get(job.id);
  if (!t) {
    const map = new Heightmap(job.stock);
    const m = new Machine(
      interpret(job.reference, { rack: jobRack(job) }),
      map,
    );
    m.finish();
    t = { target: map, par: m.time };
    targets.set(job.id, t);
  }
  return t;
}
