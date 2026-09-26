export type ToolTip = "flat" | "ball" | "drill";

export interface Tool {
  number: number;
  name: string;
  tip: ToolTip;
  diameter: number;
  flutes: number;
  /** Cutting length. Material above this contacts the holder. */
  fluteLength: number;
  /** Max side-cutting depth per pass before the tool breaks. */
  maxDepthOfCut: number;
  /** Max feed per tooth (mm) before the tool breaks. */
  maxChipLoad: number;
  color: string;
}

export const TOOLS: Tool[] = [
  {
    number: 1,
    name: "Ø50 face mill",
    tip: "flat",
    diameter: 50,
    flutes: 5,
    fluteLength: 6,
    maxDepthOfCut: 3,
    maxChipLoad: 0.2,
    color: "#8a8f98",
  },
  {
    number: 2,
    name: "Ø10 flat end mill",
    tip: "flat",
    diameter: 10,
    flutes: 3,
    fluteLength: 22,
    maxDepthOfCut: 5,
    maxChipLoad: 0.08,
    color: "#c9a24a",
  },
  {
    number: 3,
    name: "Ø6 flat end mill",
    tip: "flat",
    diameter: 6,
    flutes: 3,
    fluteLength: 15,
    maxDepthOfCut: 3,
    maxChipLoad: 0.05,
    color: "#c9a24a",
  },
  {
    number: 4,
    name: "Ø6 ball end mill",
    tip: "ball",
    diameter: 6,
    flutes: 2,
    fluteLength: 12,
    maxDepthOfCut: 2,
    maxChipLoad: 0.05,
    color: "#7fb2c9",
  },
  {
    number: 5,
    name: "Ø6 drill",
    tip: "drill",
    diameter: 6,
    flutes: 2,
    fluteLength: 30,
    maxDepthOfCut: 30,
    maxChipLoad: 0.15,
    color: "#d9d4c7",
  },
  {
    number: 6,
    name: "Ø3 flat end mill",
    tip: "flat",
    diameter: 3,
    flutes: 2,
    fluteLength: 8,
    maxDepthOfCut: 1.5,
    maxChipLoad: 0.03,
    color: "#c9a24a",
  },
];

export function getTool(n: number): Tool | undefined {
  return TOOLS.find((t) => t.number === n);
}

/** Height of the tool's cutting surface above its tip at radial distance d. */
export function tipProfile(tool: Tool, d: number): number {
  const r = tool.diameter / 2;
  switch (tool.tip) {
    case "flat":
      return 0;
    case "ball":
      return r - Math.sqrt(Math.max(0, r * r - d * d));
    case "drill":
      // 118° point: height rises d / tan(59°)
      return d * 0.6009;
  }
}
