import { useState } from 'react';
import { useAuth } from './hooks/useAuth';
import { LeagueProvider } from './hooks/useLeague';
import UploadPage      from './pages/UploadPage';
import LeaderboardPage from './pages/LeaderboardPage';
import StandingsPage   from './pages/StandingsPage';
import TrackPage       from './pages/TrackPage';
import ProfilePage     from './pages/ProfilePage';

// Paste the full CSS string from xcleague-app.jsx here,
// or import it from a shared CSS file.
// For brevity this imports the styles defined in index.css.

type Page = 'upload' | 'leaderboard' | 'standings' | 'track' | 'profile';

function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

interface NavItem {
  id:    Page;
  icon:  string;
  label: string;
  auth?: boolean;
}

const NAV: NavItem[] = [
  { id: 'upload',      icon: '↑',  label: 'Upload',    auth: true },
  { id: 'leaderboard', icon: '🏆', label: 'Results'  },
  { id: 'standings',   icon: '≡',  label: 'Standings' },
  { id: 'track',       icon: '◈',  label: 'Track Map', auth: true },
  { id: 'profile',     icon: '◉',  label: 'Profile',  auth: true },
];

export default function App() {
  const { user, isLoading, login, logout } = useAuth();
  const [page, setPage] = useState<Page>('leaderboard');

  const handleNavClick = (item: NavItem) => {
    if (item.auth && !user) { login(); return; }
    setPage(item.id);
  };

  // Provide league context — in a router-based setup these come from URL params
  return (
    <LeagueProvider leagueSlug="alps-xc-2025" seasonId="season-1">
      <div className="app">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-logo">
            <div className="logo-mark">XC League</div>
            <div className="logo-league">Alps XC<br />Summer 2025</div>
          </div>

          <nav className="sidebar-nav">
            <div className="nav-section-label">Compete</div>
            {NAV.slice(0, 1).map(item => (
              <button
                key={item.id}
                className={`nav-item${page === item.id ? ' active' : ''}`}
                onClick={() => handleNavClick(item)}
              >
                <span style={{ fontSize: 15, lineHeight: 1 }}>{item.icon}</span>
                <span>{item.label}</span>
                {item.auth && !user && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.4 }}>🔒</span>}
              </button>
            ))}

            <div className="nav-section-label">Results</div>
            {NAV.slice(1, 4).map(item => (
              <button
                key={item.id}
                className={`nav-item${page === item.id ? ' active' : ''}`}
                onClick={() => handleNavClick(item)}
              >
                <span style={{ fontSize: 15, lineHeight: 1 }}>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}

            <div className="nav-section-label">Account</div>
            {NAV.slice(4).map(item => (
              <button
                key={item.id}
                className={`nav-item${page === item.id ? ' active' : ''}`}
                onClick={() => handleNavClick(item)}
              >
                <span style={{ fontSize: 15, lineHeight: 1 }}>{item.icon}</span>
                <span>{item.label}</span>
                {item.auth && !user && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.4 }}>🔒</span>}
              </button>
            ))}
          </nav>

          {/* User section */}
          <div
            className="sidebar-user"
            onClick={() => user ? setPage('profile') : login()}
          >
            {isLoading ? (
              <div className="shimmer" style={{ width: 32, height: 32, borderRadius: '50%' }} />
            ) : user ? (
              <>
                <div className="avatar">{initials(user.displayName)}</div>
                <div>
                  <div className="user-name">{user.displayName.split(' ')[0]}</div>
                  <div className="user-role">pilot</div>
                </div>
              </>
            ) : (
              <>
                <div className="avatar" style={{ color: 'var(--text3)' }}>?</div>
                <div>
                  <div className="user-name" style={{ color: 'var(--text2)' }}>Sign in</div>
                  <div className="user-role">via Google</div>
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Main content */}
        <main className="main">
          {page === 'upload'      && <UploadPage />}
          {page === 'leaderboard' && <LeaderboardPage />}
          {page === 'standings'   && <StandingsPage />}
          {page === 'track'       && <TrackPage />}
          {page === 'profile'     && <ProfilePage />}
        </main>
      </div>
    </LeagueProvider>
  );
}
