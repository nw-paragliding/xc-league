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
import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
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

  // Fetch seasons to get the active season ID
  const { data: seasonsData } = useQuery({
    queryKey: ['seasons', slug],
    queryFn: () => leagueApi.listSeasons(slug),
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
  });

  // Redirect authenticated users to onboarding until wind rating is set
  if (isFetched && user && user.windRating === null) {
    return <Navigate to="/onboarding" replace />;
  }

  const seasons = seasonsData?.seasons ?? [];
  const activeSeason = seasons.find((s) => s.status === 'open') ?? seasons[0];
  const seasonId = activeSeason?.id ?? '';

  return (
    <LeagueProvider leagueSlug={slug} seasonId={seasonId}>
      <LeagueShell leagueSlug={slug} />
    </LeagueProvider>
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
