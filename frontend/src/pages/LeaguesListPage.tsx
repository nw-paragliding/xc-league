// =============================================================================
// LeaguesListPage — browse and join leagues
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { leagueApi } from '../api/leagues';
import UserMenuPopout from '../components/UserMenuPopout';
import { useAuth } from '../hooks/useAuth';

export default function LeaguesListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['leagues'],
    queryFn: () => leagueApi.list(),
    staleTime: 60 * 1000,
  });

  const leagues = data?.leagues ?? [];

  return (
    <>
      <UserMenuPopout isLeagueAdmin={false} />

      <div style={{ minHeight: '100dvh', background: 'var(--bg)', width: '100%' }}>
        <div className="page-container" style={{ maxWidth: 520 }}>
          {/* Header */}
          <div style={{ marginBottom: '2.5rem' }}>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.5rem' }}>Leagues</h1>
            <p style={{ fontSize: 14, color: 'var(--text2)' }}>Browse XC paragliding leagues and competitions.</p>
          </div>

          {/* League list */}
          {isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="shimmer" style={{ height: 80, borderRadius: 8 }} />
              ))}
            </div>
          ) : leagues.length === 0 ? (
            <div
              style={{
                padding: '3rem',
                textAlign: 'center',
                color: 'var(--text3)',
                border: '1px dashed var(--border)',
                borderRadius: 8,
              }}
            >
              <div style={{ fontSize: 32, marginBottom: 12 }}>🪂</div>
              <div style={{ fontWeight: 500, marginBottom: 8 }}>No leagues yet</div>
              {user && (
                <button
                  onClick={() => navigate('/leagues/_/create-league')}
                  style={{
                    marginTop: 8,
                    padding: '0.5rem 1.25rem',
                    background: 'var(--primary)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 500,
                  }}
                >
                  Create the first league
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {leagues.map((league) => (
                <button
                  key={league.id}
                  onClick={() => navigate(`/leagues/${league.slug}`)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    padding: '1rem 1.25rem',
                    background: 'var(--bg2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                    minWidth: 0,
                    overflow: 'hidden',
                    transition: 'border-color 0.15s, background 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)';
                    (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg3)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
                    (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg2)';
                  }}
                >
                  {/* Logo or placeholder */}
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 8,
                      background: 'var(--bg3)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 22,
                      flexShrink: 0,
                      overflow: 'hidden',
                    }}
                  >
                    {league.logoUrl ? (
                      <img src={league.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      '🪂'
                    )}
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)', marginBottom: 2 }}>
                      {league.name}
                    </div>
                    {league.shortDescription && (
                      <div
                        style={{
                          fontSize: 13,
                          color: 'var(--text3)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                        }}
                      >
                        {league.shortDescription}
                      </div>
                    )}
                  </div>

                  {/* Arrow */}
                  <div style={{ color: 'var(--text3)', fontSize: 18, flexShrink: 0 }}>›</div>
                </button>
              ))}
            </div>
          )}

          {/* Create league CTA for logged-in users */}
          {user && leagues.length > 0 && (
            <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border)' }}>
              <button
                onClick={() => navigate('/leagues/_/create-league')}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'none',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--text2)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                + Create a new league
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
