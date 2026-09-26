import { formatTime } from "./Controls";
import { starString, type RunResult } from "./Workshop";

interface Props {
  result: RunResult;
  hasNext: boolean;
  onClose: () => void;
  onRetry: () => void;
  onNext: () => void;
}

export function Results({ result, hasNext, onClose, onRetry, onNext }: Props) {
  const { comparison: c, grade: g, time, par } = result;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <div className="results">
      <div className={`results-card ${g.passed ? "pass" : "fail"}`}>
        <div className="verdict">
          {g.passed ? "Part accepted" : "Part rejected"}
        </div>
        {g.passed && <div className="stars big">{starString(g.stars)}</div>}
        <dl>
          <div>
            <dt>In tolerance</dt>
            <dd>{pct(c.accuracy)}</dd>
          </div>
          <div>
            <dt>Material left</dt>
            <dd>
              {pct(c.remaining)}
              {c.maxRemaining > 0 && ` · ${c.maxRemaining.toFixed(2)} mm`}
            </dd>
          </div>
          <div>
            <dt>Cut too deep</dt>
            <dd>
              {pct(c.gouged)}
              {c.maxGouge > 0 && ` · ${c.maxGouge.toFixed(2)} mm`}
            </dd>
          </div>
          <div>
            <dt>Cycle time</dt>
            <dd>
              {formatTime(time)} <small>par {formatTime(par)}</small>
            </dd>
          </div>
        </dl>
        {g.reasons.length > 0 && (
          <ul className="reasons">
            {g.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {g.passed && g.stars < 3 && (
          <p className="nudge">
            Beat par for three stars: fewer passes, fewer rapids, or a faster
            feed the tool can handle.
          </p>
        )}
        {!g.passed && (
          <p className="nudge">
            Blue areas still have material; red areas were cut too deep.
          </p>
        )}
        <div className="actions">
          <button className="ghost" onClick={onClose}>
            Inspect part
          </button>
          <button className="ghost" onClick={onRetry}>
            Reset stock
          </button>
          {g.passed && hasNext && (
            <button className="btn start" onClick={onNext}>
              Next job →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
