// =============================================================================
// App — Root layout + routing
//
// URL structure:
//   /                          → fetches league list, redirects to first league
//   /leagues/:leagueSlug       → home page (leaderboard + tasks)
//   /leagues/:leagueSlug/:page → named page within a league
// =============================================================================

import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './hooks/useAuth';
import { LeagueProvider } from './hooks/useLeague';
import { leagueApi } from './api/leagues';
import HomePage             from './pages/HomePage';
import ProfilePage          from './pages/ProfilePage';
import SuperAdminPage       from './pages/SuperAdminPage';
import CreateLeaguePage     from './pages/CreateLeaguePage';
import LeagueSettingsPage   from './pages/LeagueSettingsPage';
import OnboardingPage       from './pages/OnboardingPage';
import UserMenuPopout       from './components/UserMenuPopout';

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
    enabled: !!slug && slug !== '_',
    staleTime: 5 * 60 * 1000,
  });

  // Redirect authenticated users to onboarding until wind rating is set
  if (isFetched && user && user.windRating === null) {
    return <Navigate to="/onboarding" replace />;
  }

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
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isLeagueAdmin, setIsLeagueAdmin] = useState(false);

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

  return (
    <div className="app">
      {/* Floating user menu — bottom left */}
      <UserMenuPopout isLeagueAdmin={isLeagueAdmin} />

      {/* Full-width main content */}
      <main className="main" style={{ padding: 0 }}>
        <Routes>
          <Route index                  element={<HomePage />} />
          <Route path="tasks"           element={<HomePage />} />
          <Route path="season"          element={<HomePage />} />
          <Route path="profile"         element={<ProfilePage />} />
          <Route path="super-admin"     element={<SuperAdminPage />} />
          <Route path="create-league"   element={<CreateLeaguePage onSuccess={() => navigate(`/leagues/${leagueSlug}`)} />} />
          <Route path="league-settings" element={<LeagueSettingsPage />} />
          {/* Catch-all: redirect unknown sub-paths to home */}
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

  return <Navigate to="/leagues/_/create-league" replace />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Root App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DefaultLeagueRedirect />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/leagues/:leagueSlug/*" element={<LeagueLayout />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
