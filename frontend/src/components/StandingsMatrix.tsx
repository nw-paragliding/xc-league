import type { StandingsEntry } from '../api/standings';
import type { Task } from '../api/tasks';

// ─────────────────────────────────────────────────────────────────────────────
// Shared styles
// ─────────────────────────────────────────────────────────────────────────────

const TH: React.CSSProperties = {
  padding: '4px 5px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text3)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  padding: '5px 5px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  whiteSpace: 'nowrap',
};

function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        background: top ? 'rgba(59,130,246,0.15)' : 'transparent',
        color: top ? 'var(--accent)' : 'var(--text3)',
      }}
    >
      {rank}
    </span>
  );
}

function PilotCell({ name, isMe }: { name: string; isMe: boolean }) {
  return (
    <td style={TD}>
      <span style={{ fontWeight: isMe ? 700 : 400, color: isMe ? 'var(--accent)' : 'var(--text)', fontSize: 12 }}>
        {name}
      </span>
      {isMe && (
        <span
          style={{ marginLeft: 5, fontSize: 9, color: 'var(--accent)', fontFamily: 'var(--font-mono)', opacity: 0.7 }}
        >
          you
        </span>
      )}
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StandingsMatrix
// ─────────────────────────────────────────────────────────────────────────────

export interface StandingsMatrixProps {
  standings: StandingsEntry[];
  tasks: Task[];
  scoreMap: Map<string, Map<string, number>>;
  maxByTask: Record<string, number>;
  myId: string | undefined;
}

export default function StandingsMatrix({ standings, tasks, scoreMap, maxByTask, myId }: StandingsMatrixProps) {
  if (!standings.length) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
        No pilots have flown yet this season
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 24 }}>#</th>
            <th style={{ ...TH }}>Pilot</th>
            <th style={{ ...TH, textAlign: 'right', paddingRight: 10 }}>Total</th>
            {tasks.map((t) => (
              <th key={t.id} style={{ ...TH, textAlign: 'center', width: 44 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 44 }}>
                  {t.name}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {standings.map((row) => {
            const isMe = row.pilotId === myId;
            return (
              <tr key={row.pilotId} style={{ background: isMe ? 'rgba(59,130,246,0.07)' : undefined }}>
                <td style={TD}>
                  <RankBadge rank={row.rank} />
                </td>
                <PilotCell name={row.pilotName} isMe={isMe} />
                <td style={{ ...TD, textAlign: 'right', paddingRight: 10 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11, color: 'var(--text)' }}>
                    {row.totalPoints.toLocaleString()}
                  </span>
                </td>
                {tasks.map((task) => {
                  const pts = scoreMap.get(task.id)?.get(row.pilotId);
                  const max = maxByTask[task.id] ?? 1;
                  const ratio = pts != null ? pts / max : 0;
                  return (
                    <td key={task.id} style={{ ...TD, textAlign: 'center', width: 44 }}>
                      {pts != null ? (
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '1px 3px',
                            borderRadius: 3,
                            fontFamily: 'var(--font-mono)',
                            fontWeight: 600,
                            fontSize: 11,
                            background: `rgba(59,130,246,${(0.07 + ratio * 0.25).toFixed(2)})`,
                            color: ratio >= 0.5 ? '#93c5fd' : 'var(--text2)',
                          }}
                        >
                          {Math.round(pts)}
                        </span>
                      ) : (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
