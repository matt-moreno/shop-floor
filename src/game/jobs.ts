import { interpret } from "../sim/gcode";
import { Machine } from "../sim/machine";
import { Heightmap, type StockSpec } from "../sim/stock";

export interface Job {
  id: string;
  title: string;
  customer: string;
  summary: string;
  /** Short lines shown in the brief. */
  spec: string[];
  tips: string[];
  tools: number[];
  stock: StockSpec;
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
    id: "sandbox",
    title: "Sandbox",
    customer: "Your shop",
    summary:
      "A 100 × 80 × 30 block and the whole tool rack. No grading, just cutting.",
    spec: ["Stock 100 × 80 × 30 mm", "All tools available"],
    tips: [
      "Try the ball end mill (T4) with a sloped G1 or G2 move for a 3D surface.",
      "Supported: G0 G1 G2 G3 G4 G17-19 G20/21 G28 G73 G80-83 G90/91 G98/99, M0 M3 M4 M5 M6 M8 M9 M30.",
    ],
    tools: [1, 2, 3, 4, 5, 6],
    stock: { width: 100, depth: 80, height: 30 },
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

export interface JobTarget {
  target: Heightmap;
  par: number;
}

const targets = new Map<string, JobTarget>();

export function jobTarget(job: Job): JobTarget {
  let t = targets.get(job.id);
  if (!t) {
    const map = new Heightmap(job.stock);
    const m = new Machine(interpret(job.reference), map);
    m.finish();
    t = { target: map, par: m.time };
    targets.set(job.id, t);
  }
  return t;
}
