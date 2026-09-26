import { useCallback, useState } from "react";
import { JOBS } from "./game/jobs";
import { loadProgress, saveProgress, type Progress } from "./game/progress";
import { Workshop, starString } from "./ui/Workshop";

export function App() {
  const [progress, setProgress] = useState<Progress>(loadProgress);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = JOBS.find((j) => j.id === jobId);

  const update = useCallback((fn: (p: Progress) => Progress) => {
    setProgress((p) => {
      const next = fn(p);
      saveProgress(next);
      return next;
    });
  }, []);
  const onSave = useCallback(
    (src: string) =>
      jobId &&
      update((p) => ({ ...p, programs: { ...p.programs, [jobId]: src } })),
    [jobId, update],
  );
  const onStars = useCallback(
    (n: number) =>
      jobId &&
      update((p) => ({
        ...p,
        stars: { ...p.stars, [jobId]: Math.max(n, p.stars[jobId] ?? 0) },
      })),
    [jobId, update],
  );

  if (job) {
    const idx = JOBS.indexOf(job);
    const next = JOBS[idx + 1];
    return (
      <Workshop
        key={job.id}
        job={job}
        initialSource={progress.programs[job.id] ?? job.starter}
        best={progress.stars[job.id] ?? 0}
        hasNext={!!next}
        onSave={onSave}
        onStars={onStars}
        onExit={() => setJobId(null)}
        onNext={() => next && setJobId(next.id)}
      />
    );
  }

  return (
    <div className="home">
      <header>
        <h1>Shop Floor</h1>
        <p>Write G-code, cut metal, ship parts. A 3-axis CNC mill simulator.</p>
      </header>
      <div className="jobs">
        {JOBS.map((j, k) => {
          const stars = progress.stars[j.id] ?? 0;
          const unlocked =
            j.sandbox || k === 0 || (progress.stars[JOBS[k - 1].id] ?? 0) > 0;
          return (
            <button
              key={j.id}
              className={`job ${unlocked ? "" : "locked"}`}
              disabled={!unlocked}
              onClick={() => setJobId(j.id)}
            >
              <span className="num">
                {j.sandbox ? "∞" : String(k + 1).padStart(2, "0")}
              </span>
              <span className="name">{j.title}</span>
              <span className="cust">{j.customer}</span>
              <span className="desc">
                {unlocked ? j.summary : "Finish the previous job to unlock."}
              </span>
              {!j.sandbox && <span className="stars">{starString(stars)}</span>}
            </button>
          );
        })}
      </div>
      <footer>
        Simplified simulation for learning and fun. Don't run these programs on
        a real machine without checking them.
      </footer>
    </div>
  );
}
