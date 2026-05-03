import { useQuery } from '@tanstack/react-query';
import { type Submission, submissionsApi } from '../api/tasks';
import { useLeague } from '../hooks/useLeague';

const TH: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text3)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  padding: '5px 8px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Plain-English label for what the pilot reached on this attempt.
 * `lastTurnpointIndex` is 0 for SSS-only, then 1..N for each turnpoint reached.
 * Goal trumps everything else.
 */
function reachedLabel(s: NonNullable<Submission['thisSubmission']>, totalTurnpoints: number) {
  if (s.reachedGoal) return 'Reached goal';
  if (s.lastTurnpointIndex === 0) return 'Reached SSS';
  // turnpoints array indexes 0=SSS, 1..N-1=intermediates+ESS+GOAL.
  // Pilot-facing TP numbering treats SSS as "the start" and counts from TP1.
  return `Reached TP${s.lastTurnpointIndex} of ${Math.max(0, totalTurnpoints - 2)}`;
}

interface Props {
  taskId: string;
  /** Total turnpoints in the task (used to format "TP X of N"). */
  totalTurnpoints: number;
}

export default function MySubmissions({ taskId, totalTurnpoints }: Props) {
  const { leagueSlug, seasonId } = useLeague();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['submissions', leagueSlug, seasonId, taskId],
    queryFn: () => submissionsApi.list(leagueSlug, seasonId, taskId),
    select: (res) => res.submissions,
    staleTime: 60 * 1000,
  });

  if (isLoading || isError || !data || data.length === 0) {
    // Empty / loading / error states are silent — the upload zone above this
    // already handles "no submissions yet" and the leaderboard itself surfaces
    // any score. There's nothing useful to show here in those cases.
    return null;
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--text3)',
          fontFamily: 'var(--font-mono)',
          marginBottom: 8,
        }}
      >
        Your Submissions
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={TH}>Submitted</th>
              <th style={TH}>File</th>
              <th style={TH}>Result</th>
              <th style={{ ...TH, textAlign: 'right' }}>Dist</th>
            </tr>
          </thead>
          <tbody>
            {data.map((sub) => {
              const f = sub.thisSubmission;
              return (
                <tr key={sub.id} style={{ background: sub.isCurrentBest ? 'rgba(59,130,246,0.07)' : undefined }}>
                  <td style={{ ...TD, fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                    {fmtDateTime(sub.submittedAt)}
                  </td>
                  <td style={{ ...TD, color: 'var(--text2)' }}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{sub.igcFilename}</span>
                    {sub.isCurrentBest && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          color: 'var(--accent)',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 700,
                        }}
                      >
                        ← scored as best
                      </span>
                    )}
                  </td>
                  <td style={{ ...TD, color: 'var(--text)' }}>
                    {f ? (
                      <>
                        {reachedLabel(f, totalTurnpoints)}
                        {f.hasFlaggedCrossings && (
                          <span
                            role="img"
                            aria-label="Unconfirmed turnpoint crossing"
                            title="Unconfirmed crossing"
                            style={{ marginLeft: 6, color: 'var(--warning)' }}
                          >
                            ⚑
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: 'var(--text3)' }}>{sub.status.toLowerCase()}</span>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                    {f ? `${f.distanceFlownKm.toFixed(2)} km` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
