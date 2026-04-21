// =============================================================================
// App — Root layout + routing
//
// URL structure:
//   /                          → fetches league list, redirects to first league
//   /leagues/:leagueSlug       → home page (leaderboard + tasks)
//   /leagues/:leagueSlug/:page → named page within a league
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
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
  const { user } = useAuth();
  const [isLeagueAdmin, setIsLeagueAdmin] = useState(false);

  // Check league admin status
  useEffect(() => {
    if (!user) {
      setIsLeagueAdmin(false);
      return;
    }
    if (user.isAdmin) {
      setIsLeagueAdmin(true);
      return;
    }

    leagueApi
      .listMembers(leagueSlug)
      .then((data) => {
        const membership = data.members.find((m) => m.userId === user.id);
        setIsLeagueAdmin(membership?.role === 'admin');
      })
      .catch(() => setIsLeagueAdmin(false));
  }, [user, leagueSlug]);

  return (
    <div className="app">
      {/* Floating user menu — bottom left */}
      <UserMenuPopout isLeagueAdmin={isLeagueAdmin} />

      {/* Full-width main content */}
      <main className="main" style={{ padding: 0 }}>
        <Routes>
          <Route index element={<HomePage />} />
          <Route path="tasks" element={<HomePage />} />
          <Route path="season" element={<HomePage />} />
          <Route path="league-settings" element={<LeagueSettingsPage />} />
          {/* Catch-all: redirect unknown sub-paths to home */}
          <Route path="*" element={<Navigate to={`/leagues/${leagueSlug}`} replace />} />
        </Routes>
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
      <Route path="/" element={<Navigate to="/leagues" replace />} />
      <Route path="/leagues" element={<LeaguesListPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/create-league" element={<CreateLeaguePage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/super-admin" element={<SuperAdminPage />} />
      <Route path="/leagues/:leagueSlug/*" element={<LeagueLayout />} />
      <Route path="*" element={<Navigate to="/leagues" replace />} />
    </Routes>
  );
}
