import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { leagueApi, type Season, type CreateSeasonInput } from '../api/leagues';
import { useLeague } from '../hooks/useLeague';

export default function SeasonManagementPage() {
  const { leagueSlug } = useLeague();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editingSeason, setEditingSeason] = useState<Season | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['leagues', leagueSlug, 'seasons'],
    queryFn: () => leagueApi.listSeasons(leagueSlug),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateSeasonInput) => leagueApi.createSeason(leagueSlug, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons'] });
      setIsCreating(false);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to create season');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ seasonId, input }: { seasonId: string; input: any }) =>
      leagueApi.updateSeason(leagueSlug, seasonId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons'] });
      setEditingSeason(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to update season');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (seasonId: string) => leagueApi.deleteSeason(leagueSlug, seasonId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons'] });
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to delete season');
    },
  });

  const openMutation = useMutation({
    mutationFn: (seasonId: string) => leagueApi.openSeason(leagueSlug, seasonId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons'] });
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to open season');
    },
  });

  const closeMutation = useMutation({
    mutationFn: (seasonId: string) => leagueApi.closeSeason(leagueSlug, seasonId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'seasons'] });
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to close season');
    },
  });

  if (isLoading) {
    return (
      <div style={{ padding: '2rem' }}>
        <div className="shimmer" style={{ width: '100%', height: 400 }} />
      </div>
    );
  }

  if (queryError) {
    return (
      <div style={{ padding: '2rem' }}>
        <div style={{
          padding: '1rem',
          background: '#fee',
          border: '1px solid #fcc',
          borderRadius: 8,
          color: '#c00'
        }}>
          Error loading seasons: {queryError.message}
        </div>
      </div>
    );
  }

  const seasons = data?.seasons || [];

  return (
    <div style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Season Management
          </h1>
          <p style={{ color: 'var(--text2)' }}>
            Create and manage competition seasons for {leagueSlug}
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          style={{
            padding: '0.75rem 1.5rem',
            border: 'none',
            borderRadius: 4,
            background: 'var(--primary)',
            color: 'white',
            cursor: 'pointer',
            fontSize: '1rem',
            fontWeight: 500
          }}
        >
          + New Season
        </button>
      </header>

      {error && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.75rem 1rem',
          background: '#fee',
          border: '1px solid #fcc',
          borderRadius: 6,
          color: '#c00',
          fontSize: '0.875rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#c00',
              cursor: 'pointer',
              fontSize: '1.25rem',
              padding: 0,
              lineHeight: 1
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Create Season Form */}
      {isCreating && (
        <SeasonForm
          onSubmit={(input) => createMutation.mutate(input)}
          onCancel={() => setIsCreating(false)}
          isSubmitting={createMutation.isPending}
        />
      )}

      {/* Edit Season Form */}
      {editingSeason && (
        <SeasonForm
          season={editingSeason}
          onSubmit={(input) => updateMutation.mutate({ seasonId: editingSeason.id, input })}
          onCancel={() => setEditingSeason(null)}
          isSubmitting={updateMutation.isPending}
        />
      )}

      {/* Seasons List */}
      <div style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden'
      }}>
        {seasons.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text2)' }}>
            No seasons yet. Create your first season to get started.
          </div>
        ) : (
          seasons.map((season, i) => (
            <div
              key={season.id}
              style={{
                padding: '1.5rem',
                borderBottom: i < seasons.length - 1 ? '1px solid var(--border)' : 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '1.125rem' }}>
                    {season.name}
                  </span>
                  {season.status === 'draft' && (
                    <span style={{
                      padding: '0.25rem 0.5rem',
                      background: '#e0e0e0',
                      color: '#666',
                      borderRadius: 4,
                      fontSize: '0.75rem',
                      fontWeight: 500
                    }}>
                      DRAFT
                    </span>
                  )}
                  {season.status === 'open' && (
                    <span style={{
                      padding: '0.25rem 0.5rem',
                      background: '#d1fae5',
                      color: '#065f46',
                      borderRadius: 4,
                      fontSize: '0.75rem',
                      fontWeight: 500
                    }}>
                      OPEN
                    </span>
                  )}
                  {season.status === 'closed' && (
                    <span style={{
                      padding: '0.25rem 0.5rem',
                      background: '#fee',
                      color: '#991b1b',
                      borderRadius: 4,
                      fontSize: '0.75rem',
                      fontWeight: 500
                    }}>
                      CLOSED
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '0.25rem' }}>
                  Type: {season.competitionType === 'XC' ? 'Cross Country' : 'Hike & Fly'}
                </div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                  {new Date(season.startDate).toLocaleDateString()} - {new Date(season.endDate).toLocaleDateString()}
                </div>
                {season.taskCount !== undefined && (
                  <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
                    {season.taskCount} task{season.taskCount !== 1 ? 's' : ''} • {season.registeredPilotCount || 0} pilot{season.registeredPilotCount !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {season.status === 'draft' && (
                  <button
                    onClick={() => {
                      if (confirm(`Open season "${season.name}"? Pilots will be able to register and view tasks.`)) {
                        openMutation.mutate(season.id);
                      }
                    }}
                    disabled={openMutation.isPending}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid #86efac',
                      borderRadius: 4,
                      background: '#d1fae5',
                      color: '#065f46',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: 500
                    }}
                  >
                    Open Season
                  </button>
                )}
                {season.status === 'open' && (
                  <button
                    onClick={() => {
                      if (confirm(`Close season "${season.name}"? This will freeze all task scores and prevent new submissions. This cannot be undone.`)) {
                        closeMutation.mutate(season.id);
                      }
                    }}
                    disabled={closeMutation.isPending}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid #fca5a5',
                      borderRadius: 4,
                      background: '#fee',
                      color: '#991b1b',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: 500
                    }}
                  >
                    Close Season
                  </button>
                )}
                {season.status !== 'closed' && (
                  <button
                    onClick={() => setEditingSeason(season)}
                    disabled={updateMutation.isPending}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      background: 'var(--bg1)',
                      color: 'var(--text1)',
                      cursor: 'pointer',
                      fontSize: '0.875rem'
                    }}
                  >
                    Edit
                  </button>
                )}
                {season.status === 'draft' && (
                  <button
                    onClick={() => {
                      if (confirm(`Delete season "${season.name}"? This cannot be undone.`)) {
                        deleteMutation.mutate(season.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid #fcc',
                      borderRadius: 4,
                      background: 'var(--bg1)',
                      color: '#c00',
                      cursor: 'pointer',
                      fontSize: '0.875rem'
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface SeasonFormProps {
  season?: Season;
  onSubmit: (input: CreateSeasonInput) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

function SeasonForm({ season, onSubmit, onCancel, isSubmitting }: SeasonFormProps) {
  const [name, setName] = useState(season?.name || '');
  const [competitionType, setCompetitionType] = useState<'XC' | 'HIKE_AND_FLY'>(season?.competitionType || 'XC');
  const [startDate, setStartDate] = useState(season?.startDate?.split('T')[0] || '');
  const [endDate, setEndDate] = useState(season?.endDate?.split('T')[0] || '');
  const [nominalDistanceKm, setNominalDistanceKm] = useState(season?.nominalDistanceKm?.toString() || '70');
  const [nominalTimeS, setNominalTimeS] = useState(season?.nominalTimeS?.toString() || '5400');
  const [nominalGoalRatio, setNominalGoalRatio] = useState(season?.nominalGoalRatio?.toString() || '0.3');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      competitionType,
      startDate,
      endDate,
      nominalDistanceKm: parseFloat(nominalDistanceKm),
      nominalTimeS: parseInt(nominalTimeS, 10),
      nominalGoalRatio: parseFloat(nominalGoalRatio),
    });
  };

  return (
    <div style={{
      marginBottom: '2rem',
      padding: '1.5rem',
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--bg2)'
    }}>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
        {season ? 'Edit Season' : 'Create New Season'}
      </h2>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
              Season Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Summer 2025"
              required
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: '0.875rem',
                background: 'var(--bg1)',
                color: 'var(--text1)'
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
              Competition Type *
            </label>
            <select
              value={competitionType}
              onChange={(e) => setCompetitionType(e.target.value as 'XC' | 'HIKE_AND_FLY')}
              required
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: '0.875rem',
                background: 'var(--bg1)',
                color: 'var(--text1)'
              }}
            >
              <option value="XC">Cross Country (XC)</option>
              <option value="HIKE_AND_FLY">Hike & Fly</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
              Start Date *
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: '0.875rem',
                background: 'var(--bg1)',
                color: 'var(--text1)'
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, fontSize: '0.875rem' }}>
              End Date *
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: '0.875rem',
                background: 'var(--bg1)',
                color: 'var(--text1)'
              }}
            />
          </div>
        </div>

        <details style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Advanced GAP Settings</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                Nominal Distance (km)
              </label>
              <input
                type="number"
                step="0.1"
                value={nominalDistanceKm}
                onChange={(e) => setNominalDistanceKm(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: '0.875rem',
                  background: 'var(--bg1)',
                  color: 'var(--text1)'
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                Nominal Time (seconds)
              </label>
              <input
                type="number"
                value={nominalTimeS}
                onChange={(e) => setNominalTimeS(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: '0.875rem',
                  background: 'var(--bg1)',
                  color: 'var(--text1)'
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                Nominal Goal Ratio
              </label>
              <input
                type="number"
                step="0.01"
                value={nominalGoalRatio}
                onChange={(e) => setNominalGoalRatio(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: '0.875rem',
                  background: 'var(--bg1)',
                  color: 'var(--text1)'
                }}
              />
            </div>
          </div>
        </details>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              padding: '0.5rem 1rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg1)',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || !name || !startDate || !endDate}
            style={{
              padding: '0.5rem 1rem',
              border: 'none',
              borderRadius: 4,
              background: isSubmitting || !name || !startDate || !endDate ? 'var(--border)' : 'var(--primary)',
              color: 'white',
              cursor: isSubmitting || !name || !startDate || !endDate ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500
            }}
          >
            {isSubmitting ? 'Saving...' : season ? 'Update Season' : 'Create Season'}
          </button>
        </div>
      </form>
    </div>
  );
}
