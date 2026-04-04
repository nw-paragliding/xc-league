import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SeasonManagementPage from './SeasonManagementPage';

// Mock the useLeague hook
vi.mock('../hooks/useLeague', () => ({
  useLeague: () => ({ leagueSlug: 'test-league' }),
}));

// Mock the leagues API
vi.mock('../api/leagues', () => ({
  leagueApi: {
    listSeasons: vi.fn(),
    createSeason: vi.fn(),
    updateSeason: vi.fn(),
    deleteSeason: vi.fn(),
  },
}));

import { leagueApi } from '../api/leagues';

describe('SeasonManagementPage', () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const renderPage = () => {
    return render(
      <QueryClientProvider client={queryClient}>
        <SeasonManagementPage />
      </QueryClientProvider>,
    );
  };

  it('should render the page title', async () => {
    vi.mocked(leagueApi.listSeasons).mockResolvedValue({
      seasons: [],
    });

    renderPage();

    expect(screen.getByText('Season Management')).toBeInTheDocument();
    expect(screen.getByText(/Create and manage competition seasons/)).toBeInTheDocument();
  });

  it('should display seasons list', async () => {
    const mockSeasons = [
      {
        id: '1',
        name: 'Summer 2025',
        competitionType: 'XC' as const,
        startDate: '2025-06-01',
        endDate: '2025-09-30',
        nominalDistanceKm: 70,
        nominalTimeS: 5400,
        nominalGoalRatio: 0.3,
        createdAt: '2025-01-01T00:00:00Z',
        taskCount: 5,
        registeredPilotCount: 10,
      },
    ];

    vi.mocked(leagueApi.listSeasons).mockResolvedValue({
      seasons: mockSeasons,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Summer 2025')).toBeInTheDocument();
      expect(screen.getByText(/Cross Country/)).toBeInTheDocument();
      expect(screen.getByText(/5 tasks • 10 pilots/)).toBeInTheDocument();
    });
  });

  it('should show create season form when button clicked', async () => {
    vi.mocked(leagueApi.listSeasons).mockResolvedValue({
      seasons: [],
    });

    renderPage();

    const createButton = await screen.findByText('+ New Season');
    await userEvent.click(createButton);

    await waitFor(() => {
      expect(screen.getByText('Create New Season')).toBeInTheDocument();
      expect(screen.getByLabelText(/Season Name/)).toBeInTheDocument();
    });
  });

  it('should show empty state when no seasons', async () => {
    vi.mocked(leagueApi.listSeasons).mockResolvedValue({
      seasons: [],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No seasons yet/)).toBeInTheDocument();
    });
  });

  it('should handle API errors gracefully', async () => {
    vi.mocked(leagueApi.listSeasons).mockRejectedValue(new Error('Failed to load seasons'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Error loading seasons/)).toBeInTheDocument();
    });
  });
});
