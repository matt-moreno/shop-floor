const KEY = "shop-floor.v2";

export interface Progress {
  stars: Record<string, number>;
  programs: Record<string, string>;
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Progress>;
      return { stars: p.stars ?? {}, programs: p.programs ?? {} };
    }
  } catch {
    // Storage can be blocked; play without saving.
  }
  return { stars: {}, programs: {} };
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Ignore; progress just won't persist.
  }
}
