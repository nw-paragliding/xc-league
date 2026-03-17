// =============================================================================
// App — Root layout + routing
//
// URL structure:
//   /                          → fetches league list, redirects to first league
//   /leagues/:leagueSlug       → leaderboard (default page)
//   /leagues/:leagueSlug/:page → named page within a league
//
// The sidebar stays rendered at all times; only the main content area
// changes based on the current route.
// =============================================================================

import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './hooks/useAuth';
import { LeagueProvider } from './hooks/useLeague';
import { leagueApi } from './api/leagues';
import LeagueSwitcher from './components/LeagueSwitcher';
import TasksPage            from './pages/TasksPage';
import SeasonPage           from './pages/SeasonPage';
import ProfilePage          from './pages/ProfilePage';
import SuperAdminPage       from './pages/SuperAdminPage';
import CreateLeaguePage     from './pages/CreateLeaguePage';
import LeagueSettingsPage   from './pages/LeagueSettingsPage';
import OnboardingPage        from './pages/OnboardingPage';

// ─────────────────────────────────────────────────────────────────────────────
// Types & constants
// ─────────────────────────────────────────────────────────────────────────────

type PageId =
  | 'tasks' | 'season'
  | 'profile'
  | 'super-admin' | 'create-league' | 'league-settings';

interface NavItem {
  id:              PageId;
  icon:            string;
  label:           string;
  auth?:           boolean;
  adminOnly?:      boolean;
  leagueAdminOnly?: boolean;
}

const NAV: NavItem[] = [
  { id: 'tasks',  icon: '◈', label: 'Tasks'  },
  { id: 'season', icon: '≡', label: 'Results' },
];

const ACCOUNT_NAV: NavItem[] = [
  { id: 'profile', icon: '◉', label: 'Profile', auth: true },
];

const ADMIN_NAV: NavItem[] = [
  { id: 'super-admin',     icon: '⚡', label: 'Admin Panel',    auth: true, adminOnly: true },
  { id: 'league-settings', icon: '⚙',  label: 'League Admin',   auth: true, leagueAdminOnly: true },
  { id: 'create-league',   icon: '+',  label: 'Create League',  auth: true },
];

function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// League layout — sidebar + routed content for a specific league
// ─────────────────────────────────────────────────────────────────────────────

function LeagueLayout() {
  const { leagueSlug } = useParams<{ leagueSlug: string }>();
  const slug = leagueSlug ?? '';
  const { user, isFetched } = useAuth();

  // Fetch seasons to get the active season ID
  const { data: seasonsData } = useQuery({
    queryKey: ['seasons', slug],
    queryFn: () => leagueApi.listSeasons(slug),
    enabled: !!slug && slug !== '_',
    staleTime: 5 * 60 * 1000,
  });

  // Redirect authenticated users to onboarding until wind rating is set
  if (isFetched && user && user.windRating === null) {
    return <Navigate to="/onboarding" replace />;
  }

  // Pick the active season: prefer open, fall back to the first one
  const seasons = seasonsData?.seasons ?? [];
  const activeSeason = seasons.find(s => s.status === 'open') ?? seasons[0];
  const seasonId = activeSeason?.id ?? 'season-1';

  return (
    <LeagueProvider leagueSlug={slug} seasonId={seasonId}>
      <LeagueShell leagueSlug={slug} />
    </LeagueProvider>
  );
}

function LeagueShell({ leagueSlug }: { leagueSlug: string }) {
  const { user, isLoading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isLeagueAdmin, setIsLeagueAdmin] = useState(false);

  // Derive current page from URL path
  const pathParts = location.pathname.split('/');
  const currentPage = (pathParts[3] ?? 'tasks') as PageId;

  // Check league admin status
  useEffect(() => {
    if (!user) { setIsLeagueAdmin(false); return; }
    if (user.isAdmin) { setIsLeagueAdmin(true); return; }

    leagueApi.listMembers(leagueSlug)
      .then(data => {
        const membership = data.members.find(m => m.userId === user.id);
        setIsLeagueAdmin(membership?.role === 'admin');
      })
      .catch(() => setIsLeagueAdmin(false));
  }, [user, leagueSlug]);

  const navTo = (item: NavItem) => {
    if (item.auth && !user) { login(); return; }
    navigate(`/leagues/${leagueSlug}/${item.id}`);
  };

  const renderNavItems = (items: NavItem[], showLock = false) =>
    items.map(item => {
      if (item.adminOnly && (!user || !user.isAdmin)) return null;
      if (item.leagueAdminOnly && !isLeagueAdmin) return null;

      return (
        <button
          key={item.id}
          className={`nav-item${currentPage === item.id ? ' active' : ''}`}
          onClick={() => navTo(item)}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>{item.icon}</span>
          <span>{item.label}</span>
          {showLock && item.auth && !user && (
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.4 }}>🔒</span>
          )}
        </button>
      );
    });

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        {/* Logo / league name */}
        <div className="sidebar-logo">
          <div className="logo-mark">XC League</div>
        </div>

        {/* League switcher */}
        <div style={{ padding: '0 0.75rem 0.75rem' }}>
          <LeagueSwitcher />
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">League</div>
          {renderNavItems(NAV, true)}

          <div className="nav-section-label">Account</div>
          {renderNavItems(ACCOUNT_NAV, true)}

          {user && (
            <>
              <div className="nav-section-label">Management</div>
              {renderNavItems(ADMIN_NAV)}
            </>
          )}
        </nav>

        {/* User section */}
        <div
          className="sidebar-user"
          onClick={() => user ? navigate(`/leagues/${leagueSlug}/profile`) : login()}
        >
          {isLoading ? (
            <div className="shimmer" style={{ width: 32, height: 32, borderRadius: '50%' }} />
          ) : user ? (
            <>
              <div className="avatar">{initials(user.displayName)}</div>
              <div>
                <div className="user-name">{user.displayName.split(' ')[0]}</div>
                <div className="user-role">{user.email}</div>
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

      {/* Main content — nested routes */}
      <main className="main">
        <Routes>
          <Route index                  element={<TasksPage />} />
          <Route path="tasks"           element={<TasksPage />} />
          <Route path="season"          element={<SeasonPage />} />
          <Route path="profile"         element={<ProfilePage />} />
          <Route path="super-admin"     element={<SuperAdminPage />} />
          <Route path="create-league"   element={<CreateLeaguePage onSuccess={() => navigate(`/leagues/${leagueSlug}`)} />} />
          <Route path="league-settings" element={<LeagueSettingsPage />} />
          {/* Catch-all: redirect unknown sub-paths to tasks */}
          <Route path="*"               element={<Navigate to={`/leagues/${leagueSlug}`} replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DefaultLeagueRedirect — fetches league list and redirects to the first one
// ─────────────────────────────────────────────────────────────────────────────

function DefaultLeagueRedirect() {
  const { data, isLoading } = useQuery({
    queryKey: ['leagues'],
    queryFn: () => leagueApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text2)' }}>
        Loading…
      </div>
    );
  }

  const first = data?.leagues?.[0];
  if (first) {
    return <Navigate to={`/leagues/${first.slug}`} replace />;
  }

  // No leagues exist yet — send to create-league flow via a placeholder slug
  return <Navigate to="/leagues/_/create-league" replace />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Root App — top-level route tree
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Routes>
      {/* Redirect root to first available league */}
      <Route path="/" element={<DefaultLeagueRedirect />} />
      {/* Onboarding — shown to new users before they enter the league */}
      <Route path="/onboarding" element={<OnboardingPage />} />
      {/* All league pages rendered by LeagueLayout (handles nested routing) */}
      <Route path="/leagues/:leagueSlug/*" element={<LeagueLayout />} />
      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
