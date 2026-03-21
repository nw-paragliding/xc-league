import type { League } from '../api/leagues';

interface LeagueHeaderProps {
  league: League | null;
}

export default function LeagueHeader({ league }: LeagueHeaderProps) {
  if (!league) return null;

  return (
    <div style={{ marginBottom: '1.5rem', maxWidth: 640 }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 700, lineHeight: 1.2 }}>{league.name}</h1>
      {league.shortDescription && (
        <p style={{ color: 'var(--text2)', fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>
          {league.shortDescription}
        </p>
      )}
    </div>
  );
}
