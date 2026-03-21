import type { LeaderboardEntry } from '../api/tasks';

// ─────────────────────────────────────────────────────────────────────────────
// Shared styles
// ─────────────────────────────────────────────────────────────────────────────

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
};

function fmtTime(s: number | null) {
  if (!s) return '—';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 18, height: 18, borderRadius: 3,
      fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
      background: top ? 'rgba(59,130,246,0.15)' : 'transparent',
      color: top ? 'var(--accent)' : 'var(--text3)',
    }}>
      {rank}
    </span>
  );
}

function PilotCell({ name, isMe }: { name: string; isMe: boolean }) {
  return (
    <td style={TD}>
      <span style={{ fontWeight: isMe ? 700 : 400, color: isMe ? 'var(--accent)' : 'var(--text)' }}>
        {name}
      </span>
      {isMe && (
        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--font-mono)', opacity: 0.7 }}>
          you
        </span>
      )}
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskLeaderboard
// ─────────────────────────────────────────────────────────────────────────────

interface TaskLeaderboardProps {
  entries:          LeaderboardEntry[];
  isLoading:        boolean;
  myId:             string | undefined;
  selectedPilotId?: string | null;
  onSelectPilot?:   (entry: LeaderboardEntry) => void;
}

export default function TaskLeaderboard({ entries, isLoading, myId, selectedPilotId, onSelectPilot }: TaskLeaderboardProps) {
  if (isLoading) {
    return (
      <div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="shimmer" style={{ height: 42, borderRadius: 6, marginBottom: 6 }} />
        ))}
      </div>
    );
  }

  if (!entries.length) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
        No submissions yet for this task
      </div>
    );
  }

  const anyFlagged = entries.some(e => e.hasFlaggedCrossings);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: 'auto', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 28 }}>#</th>
            <th style={TH}>Pilot</th>
            <th style={{ ...TH, textAlign: 'center', width: 32 }}>↗</th>
            <th style={{ ...TH, textAlign: 'right' }}>Dist</th>
            <th style={{ ...TH, textAlign: 'right' }}>Time</th>
            <th style={{ ...TH, textAlign: 'right' }}>D.Pts</th>
            <th style={{ ...TH, textAlign: 'right' }}>T.Pts</th>
            <th style={{ ...TH, textAlign: 'right' }}>Total</th>
            {anyFlagged && <th style={{ ...TH, textAlign: 'center', width: 28 }}>⚑</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map(e => {
            const isMe       = e.pilotId === myId;
            const isSelected = e.pilotId === selectedPilotId;
            const clickable  = onSelectPilot && e.submissionId;
            return (
              <tr
                key={e.pilotId}
                onClick={clickable ? () => onSelectPilot(e) : undefined}
                style={{
                  background: isSelected ? 'rgba(167,139,250,0.12)' : isMe ? 'rgba(59,130,246,0.07)' : undefined,
                  cursor: clickable ? 'pointer' : undefined,
                  outline: isSelected ? '1px solid rgba(167,139,250,0.4)' : undefined,
                }}
              >
                <td style={TD}><RankBadge rank={e.rank} /></td>
                <PilotCell name={e.pilotName} isMe={isMe} />
                <td style={{ ...TD, textAlign: 'center' }}>
                  {e.reachedGoal
                    ? <span style={{ color: '#5db87a', fontWeight: 700, fontSize: 12 }}>✓</span>
                    : <span style={{ color: 'var(--text3)', fontSize: 12 }}>✗</span>
                  }
                </td>
                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {e.distanceFlownKm.toFixed(1)}km
                </td>
                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {fmtTime(e.taskTimeS)}
                </td>
                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {Math.round(e.distancePoints)}
                </td>
                <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                  {Math.round(e.timePoints)}
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text)' }}>
                    {Math.round(e.totalPoints)}
                  </span>
                </td>
                {anyFlagged && (
                  <td style={{ ...TD, textAlign: 'center', color: 'var(--warning)', fontSize: 14 }}>
                    {e.hasFlaggedCrossings ? '⚑' : ''}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
