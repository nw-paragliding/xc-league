import { useState, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import { LeagueProvider } from './hooks/useLeague';
import { leagueApi } from './api/leagues';
import UploadPage      from './pages/UploadPage';
import LeaderboardPage from './pages/LeaderboardPage';
import StandingsPage   from './pages/StandingsPage';
import TrackPage       from './pages/TrackPage';
import ProfilePage     from './pages/ProfilePage';
import SuperAdminPage  from './pages/SuperAdminPage';
import CreateLeaguePage from './pages/CreateLeaguePage';
import LeagueSettingsPage from './pages/LeagueSettingsPage';
import SeasonManagementPage from './pages/SeasonManagementPage';
import TaskManagementPage from './pages/TaskManagementPage';

// Paste the full CSS string from xcleague-app.jsx here,
// or import it from a shared CSS file.
// For brevity this imports the styles defined in index.css.

type Page = 'upload' | 'leaderboard' | 'standings' | 'track' | 'profile' | 'super-admin' | 'create-league' | 'league-settings' | 'season-management' | 'task-management';

function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

interface NavItem {
  id:    Page;
  icon:  string;
  label: string;
  auth?: boolean;
  adminOnly?: boolean;
  leagueAdminOnly?: boolean;
}

const NAV: NavItem[] = [
  { id: 'upload',      icon: '↑',  label: 'Upload',    auth: true },
  { id: 'leaderboard', icon: '🏆', label: 'Results'  },
  { id: 'standings',   icon: '≡',  label: 'Standings' },
  { id: 'track',       icon: '◈',  label: 'Track Map', auth: true },
  { id: 'profile',     icon: '◉',  label: 'Profile',  auth: true },
];

const ADMIN_NAV: NavItem[] = [
  { id: 'super-admin',       icon: '⚡', label: 'Admin Panel',      auth: true, adminOnly: true },
  { id: 'create-league',     icon: '+',  label: 'Create League',   auth: true },
  { id: 'league-settings',   icon: '⚙',  label: 'League Settings', auth: true, leagueAdminOnly: true },
  { id: 'season-management', icon: '📅', label: 'Seasons',         auth: true, leagueAdminOnly: true },
  { id: 'task-management',   icon: '📍', label: 'Tasks',           auth: true, leagueAdminOnly: true },
];

export default function App() {
  const { user, isLoading, login, logout } = useAuth();
  const [page, setPage] = useState<Page>('leaderboard');
  const [isLeagueAdmin, setIsLeagueAdmin] = useState(false);
  
  // Hardcoded league slug for now - in production this would come from URL
  const currentLeagueSlug = 'alps-xc-2025';
  
  // Fetch user's league membership to determine if they're a league admin
  useEffect(() => {
    if (!user) {
      setIsLeagueAdmin(false);
      return;
    }
    
    // Super admins have automatic admin access to all leagues
    if (user.isAdmin) {
      setIsLeagueAdmin(true);
      return;
    }
    
    // Fetch membership for current league
    leagueApi.listMembers(currentLeagueSlug)
      .then(data => {
        const membership = data.members.find(m => m.userId === user.id);
        setIsLeagueAdmin(membership?.role === 'admin');
      })
      .catch(() => {
        // User might not be a member of this league
        setIsLeagueAdmin(false);
      });
  }, [user]);

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

            {/* Admin section - only show if user is authenticated */}
            {user && (
              <>
                <div className="nav-section-label">Management</div>
                {ADMIN_NAV.map(item => {
                  // Hide super admin panel if user is not a super admin
                  if (item.adminOnly && !user.isAdmin) return null;
                  // Hide league settings if user is not a league admin
                  if (item.leagueAdminOnly && !isLeagueAdmin) return null;
                  
                  return (
                    <button
                      key={item.id}
                      className={`nav-item${page === item.id ? ' active' : ''}`}
                      onClick={() => handleNavClick(item)}
                    >
                      <span style={{ fontSize: 15, lineHeight: 1 }}>{item.icon}</span>
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </>
            )}
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
          {page === 'upload'           && <UploadPage />}
          {page === 'leaderboard'      && <LeaderboardPage />}
          {page === 'standings'        && <StandingsPage />}
          {page === 'track'            && <TrackPage />}
          {page === 'profile'          && <ProfilePage />}
          {page === 'super-admin'      && <SuperAdminPage />}
          {page === 'create-league'    && <CreateLeaguePage onSuccess={() => setPage('leaderboard')} />}
          {page === 'league-settings'  && <LeagueSettingsPage />}
          {page === 'season-management' && <SeasonManagementPage />}
          {page === 'task-management'  && <TaskManagementPage />}
        </main>
      </div>
    </LeagueProvider>
  );
}
