// =============================================================================
// Season Registration Page
//
// Allows pilots to browse open seasons for the current league and register
// to participate. Shows registration status per season.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { leagueApi, type Season } from '../api/leagues';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';

function StatusBadge({ status }: { status: Season['status'] }) {
  if (status === 'open') {
    return (
      <span
        style={{
          padding: '0.125rem 0.5rem',
          background: '#dcfce7',
          color: '#166534',
          borderRadius: 4,
          fontSize: '0.75rem',
          fontWeight: 600,
          letterSpacing: '0.05em',
        }}
      >
        OPEN
      </span>
    );
  }
  if (status === 'closed') {
    return (
      <span
        style={{
          padding: '0.125rem 0.5rem',
          background: '#fee2e2',
          color: '#991b1b',
          borderRadius: 4,
          fontSize: '0.75rem',
          fontWeight: 600,
          letterSpacing: '0.05em',
        }}
      >
        CLOSED
      </span>
    );
  }
  return (
    <span
      style={{
        padding: '0.125rem 0.5rem',
        background: '#f3f4f6',
        color: '#6b7280',
        borderRadius: 4,
        fontSize: '0.75rem',
        fontWeight: 600,
        letterSpacing: '0.05em',
      }}
    >
      DRAFT
    </span>
  );
}

interface SeasonRowProps {
  season: Season;
  leagueSlug: string;
}

function SeasonRow({ season, leagueSlug }: SeasonRowProps) {
  const queryClient = useQueryClient();

  const { data: regData, isLoading: regLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons', season.id, 'registration'],
    queryFn: () => leagueApi.getSeasonRegistration(leagueSlug, season.id),
  });

  const registerMutation = useMutation({
    mutationFn: () => leagueApi.registerForSeason(leagueSlug, season.id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['leagues', leagueSlug, 'seasons', season.id, 'registration'],
      });
    },
  });

  const isRegistered = regData?.isRegistered ?? false;
  const registrationCount = regData?.registrationCount ?? season.registeredPilotCount ?? 0;

  return (
    <div
      style={{
        padding: '1.5rem',
        border: '1px solid var(--border)',
        borderRadius: 8,
        marginBottom: '1rem',
        background: 'var(--bg1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}
          >
            <span style={{ fontWeight: 600, fontSize: '1.125rem' }}>{season.name}</span>
            <StatusBadge status={season.status} />
          </div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '0.25rem' }}>
            {season.competitionType === 'XC' ? 'Cross Country' : 'Hike & Fly'}
            {' · '}
            {new Date(season.startDate).toLocaleDateString()} – {new Date(season.endDate).toLocaleDateString()}
          </div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
            {registrationCount} pilot{registrationCount !== 1 ? 's' : ''} registered
            {season.taskCount !== undefined && ` · ${season.taskCount} task${season.taskCount !== 1 ? 's' : ''}`}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {regLoading ? (
            <div className="shimmer" style={{ width: 100, height: 36, borderRadius: 4 }} />
          ) : isRegistered ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.5rem 1rem',
                background: '#dcfce7',
                color: '#166534',
                borderRadius: 4,
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              <span>✓</span>
              <span>Registered</span>
            </div>
          ) : season.status === 'open' ? (
            <button
              onClick={() => registerMutation.mutate()}
              disabled={registerMutation.isPending}
              style={{
                padding: '0.5rem 1.25rem',
                border: 'none',
                borderRadius: 4,
                background: registerMutation.isPending ? 'var(--border)' : 'var(--primary)',
                color: 'white',
                cursor: registerMutation.isPending ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              {registerMutation.isPending ? 'Registering…' : 'Register'}
            </button>
          ) : (
            <span style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
              {season.status === 'closed' ? 'Registration closed' : 'Not open yet'}
            </span>
          )}
          {registerMutation.isError && (
            <span style={{ fontSize: '0.8rem', color: '#c00' }}>
              {(registerMutation.error as any)?.message || 'Registration failed'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SeasonRegistrationPage() {
  const { leagueSlug } = useLeague();
  const { user, login } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons'],
    queryFn: () => leagueApi.listSeasons(leagueSlug),
  });

  const seasons = data?.seasons ?? [];
  // Show open seasons first, then others
  const sorted = [...seasons].sort((a, b) => {
    const order = { open: 0, draft: 1, closed: 2 };
    return (order[a.status ?? 'draft'] ?? 1) - (order[b.status ?? 'draft'] ?? 1);
  });

  if (!user) {
    return (
      <div style={{ padding: '80px 36px', textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 16 }}>🔒</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Sign in to register</div>
        <div style={{ fontSize: 14, color: 'var(--text2)', fontFamily: 'var(--font-mono)', marginBottom: 24 }}>
          You need to be logged in to register for a season
        </div>
        <button className="btn btn-primary" onClick={login}>
          Continue with Google
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: 900, margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>Season Registration</h1>
        <p style={{ color: 'var(--text2)' }}>
          Register to participate in a season and submit flights. You must be registered before uploading IGC files.
        </p>
      </header>

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {[1, 2].map((k) => (
            <div key={k} className="shimmer" style={{ width: '100%', height: 100, borderRadius: 8 }} />
          ))}
        </div>
      ) : seasons.length === 0 ? (
        <div
          style={{
            padding: '3rem',
            textAlign: 'center',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--text2)',
          }}
        >
          No seasons available yet.
        </div>
      ) : (
        sorted.map((season) => <SeasonRow key={season.id} season={season} leagueSlug={leagueSlug} />)
      )}
    </div>
  );
}
