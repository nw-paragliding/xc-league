// =============================================================================
// App — Root layout + routing
//
// URL structure:
//   /                          → fetches league list, redirects to first league
//   /leagues                   → browse all leagues
//   /leagues/:leagueSlug       → home page for one league (leaderboard + tasks)
//   /leagues/:leagueSlug/:page → named page within a league
//   /profile | /super-admin | /create-league | /onboarding → user/platform-scoped pages
//
// All routes render inside <AppShell> so the floating menu appears everywhere.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { leagueApi } from './api/leagues';
import UserMenuPopout from './components/UserMenuPopout';
import { useAuth } from './hooks/useAuth';
import { LeagueProvider } from './hooks/useLeague';
import CreateLeaguePage from './pages/CreateLeaguePage';
import HomePage from './pages/HomePage';
import LeagueSettingsPage from './pages/LeagueSettingsPage';
import LeaguesListPage from './pages/LeaguesListPage';
import OnboardingPage from './pages/OnboardingPage';
import ProfilePage from './pages/ProfilePage';
import SuperAdminPage from './pages/SuperAdminPage';

// ─────────────────────────────────────────────────────────────────────────────
// League layout — full-width content for a specific league
// ─────────────────────────────────────────────────────────────────────────────

function LeagueLayout() {
  const { leagueSlug } = useParams<{ leagueSlug: string }>();
  const slug = leagueSlug ?? '';
  const { user, isFetched } = useAuth();
  const location = useLocation();

  // Fetch seasons to get the active season ID
  const { data: seasonsData, isPending: seasonsPending } = useQuery({
    queryKey: ['seasons', slug],
    queryFn: () => leagueApi.listSeasons(slug),
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
  });

  // Redirect authenticated users to onboarding until wind rating is set
  if (isFetched && user && user.windRating === null) {
    return <Navigate to="/onboarding" replace />;
  }

  if (seasonsPending) {
    return <LeagueLoadingState />;
  }

  const seasons = seasonsData?.seasons ?? [];
  const activeSeason = seasons.find((s) => s.status === 'open') ?? seasons[0];

  // League Settings manages seasons, so an admin must be able to reach it even
  // when none exist yet — otherwise the "create one from League Settings"
  // empty-state advice leads to a dead end.
  const isSettingsRoute = location.pathname.endsWith('/league-settings');
  if (!activeSeason && !isSettingsRoute) {
    return <LeagueNoSeasonsState />;
  }

  return (
    <LeagueProvider leagueSlug={slug} seasonId={activeSeason?.id ?? ''}>
      <LeagueShell leagueSlug={slug} />
    </LeagueProvider>
  );
}

function LeagueLoadingState() {
  return (
    <div style={{ padding: '2rem', maxWidth: 320 }}>
      <div className="shimmer" style={{ height: 28, borderRadius: 6, marginBottom: 12 }} />
      <div className="shimmer" style={{ height: 16, borderRadius: 4, width: '60%' }} />
    </div>
  );
}

function LeagueNoSeasonsState() {
  return (
    <div style={{ padding: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          maxWidth: 420,
          padding: '2rem',
          textAlign: 'center',
          border: '1px dashed var(--border)',
          borderRadius: 8,
          color: 'var(--text2)',
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 12 }}>🪂</div>
        <div style={{ fontWeight: 500, marginBottom: 8, color: 'var(--text)' }}>No seasons yet</div>
        <div style={{ fontSize: 14, lineHeight: 1.5 }}>
          This league hasn't opened a season yet. An admin can create one from League Settings.
        </div>
      </div>
    </div>
  );
}

function LeagueShell({ leagueSlug }: { leagueSlug: string }) {
  return (
    <Routes>
      <Route index element={<HomePage />} />
      <Route path="tasks" element={<HomePage />} />
      <Route path="season" element={<HomePage />} />
      <Route path="league-settings" element={<LeagueSettingsPage />} />
      {/* Catch-all: redirect unknown sub-paths to home */}
      <Route path="*" element={<Navigate to={`/leagues/${leagueSlug}`} replace />} />
    </Routes>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AppShell — outer frame rendered on every route (floating menu + <main>)
// ─────────────────────────────────────────────────────────────────────────────

function AppShell() {
  return (
    <div className="app">
      <UserMenuPopout />
      <main className="main" style={{ padding: 0 }}>
        <Outlet />
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Root App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/leagues" replace />} />
        <Route path="/leagues" element={<LeaguesListPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/create-league" element={<CreateLeaguePage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/super-admin" element={<SuperAdminPage />} />
        <Route path="/leagues/:leagueSlug/*" element={<LeagueLayout />} />
      </Route>
      <Route path="*" element={<Navigate to="/leagues" replace />} />
    </Routes>
  );
}
