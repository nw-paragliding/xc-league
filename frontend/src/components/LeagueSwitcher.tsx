// =============================================================================
// League Switcher
//
// Dropdown in the sidebar that lists all available leagues and navigates
// to /leagues/:leagueSlug when the user picks one.
// =============================================================================

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { leagueApi, type League } from '../api/leagues';
import { useLeague } from '../hooks/useLeague';

export default function LeagueSwitcher() {
  const navigate = useNavigate();
  const { leagueSlug } = useLeague();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['leagues'],
    queryFn: () => leagueApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  const leagues = data?.leagues ?? [];
  const currentLeague = leagues.find(l => l.slug === leagueSlug);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (league: League) => {
    setOpen(false);
    navigate(`/leagues/${league.slug}`);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: 0,
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '1.75rem', fontWeight: 700, lineHeight: 1.2, color: 'var(--text1)' }}>
          {currentLeague?.name ?? leagueSlug ?? 'Select league'}
        </span>
        <span style={{ fontSize: '1rem', color: 'var(--text3)', marginTop: 4 }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && leagues.length > 0 && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          right: 0,
          background: 'var(--bg1)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 100,
          overflow: 'hidden',
        }}>
          {leagues.map(league => (
            <button
              key={league.id}
              onClick={() => handleSelect(league)}
              style={{
                width: '100%',
                padding: '0.625rem 0.75rem',
                background: league.slug === leagueSlug ? 'var(--bg2)' : 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              {league.slug === leagueSlug && (
                <span style={{ color: 'var(--primary)', fontSize: '0.75rem' }}>✓</span>
              )}
              <div>
                <div style={{ fontSize: '0.8rem', fontWeight: league.slug === leagueSlug ? 600 : 400, color: 'var(--text1)' }}>
                  {league.name}
                </div>
                {league.shortDescription && (
                  <div style={{ fontSize: '0.7rem', color: 'var(--text3)', marginTop: 1 }}>
                    {league.shortDescription}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
