import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useLeague } from '../hooks/useLeague';
import { useTheme } from '../hooks/useTheme';

function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

interface UserMenuPopoutProps {
  isLeagueAdmin: boolean;
}

export default function UserMenuPopout({ isLeagueAdmin }: UserMenuPopoutProps) {
  const { user, isLoading, login, logout } = useAuth();
  const { leagueSlug } = useLeague();
  const { theme, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const menuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    width: '100%',
    padding: '0.5rem 0.875rem',
    background: 'none',
    border: 'none',
    borderRadius: 4,
    color: 'var(--text2)',
    fontSize: '0.875rem',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.12s',
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: 'var(--border)',
    margin: '4px 0',
  };

  return (
    <div
      ref={containerRef}
      style={{ position: 'fixed', bottom: 24, left: 24, zIndex: 100 }}
    >
      {/* Popout card — shown above the button */}
      {open && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: 0,
          width: 220,
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 8px 24px var(--shadow)',
          padding: '8px 4px',
        }}>
          {/* Nav items */}
          <button
            style={menuItemStyle}
            onClick={() => go(`/leagues/${leagueSlug}/profile`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span style={{ fontSize: 14 }}>◉</span>
            Profile
          </button>

          {isLeagueAdmin && (
            <button
              style={menuItemStyle}
              onClick={() => go(`/leagues/${leagueSlug}/league-settings`)}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <span style={{ fontSize: 14 }}>⚙</span>
              League Admin
            </button>
          )}

          {user?.isAdmin && (
            <button
              style={menuItemStyle}
              onClick={() => go(`/leagues/${leagueSlug}/super-admin`)}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <span style={{ fontSize: 14 }}>⚡</span>
              Admin Panel
            </button>
          )}

          <button
            style={menuItemStyle}
            onClick={() => go(`/leagues/${leagueSlug}/create-league`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span style={{ fontSize: 14 }}>+</span>
            Create League
          </button>

          <button
            style={menuItemStyle}
            onClick={toggleTheme}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span style={{ fontSize: 14 }}>{theme === 'dark' ? '☀' : '☾'}</span>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>

          <div style={dividerStyle} />

          {user ? (
            <button
              style={{ ...menuItemStyle, color: 'var(--text3)' }}
              onClick={() => { setOpen(false); logout?.(); }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <span style={{ fontSize: 14 }}>→</span>
              Sign out
            </button>
          ) : (
            <button
              style={menuItemStyle}
              onClick={() => { setOpen(false); login(); }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <span style={{ fontSize: 14 }}>→</span>
              Sign in
            </button>
          )}
        </div>
      )}

      {/* Avatar button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: 44, height: 44,
          borderRadius: '50%',
          background: open ? 'var(--bg3)' : 'var(--bg2)',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 12px var(--shadow)',
          transition: 'all 0.15s',
          fontSize: '0.75rem', fontWeight: 600, color: 'var(--text)',
        }}
        title={user ? user.displayName : 'Sign in'}
      >
        {isLoading ? (
          <div className="shimmer" style={{ width: 20, height: 20, borderRadius: '50%' }} />
        ) : user ? (
          initials(user.displayName)
        ) : (
          '?'
        )}
      </button>
    </div>
  );
}
