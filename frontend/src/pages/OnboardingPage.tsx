import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from '../api/auth';
import { AUTH_KEY } from '../hooks/useAuth';
import { leagueApi } from '../api/leagues';

const WIND_RATINGS = ['A', 'B', 'C', 'D', 'CCC'] as const;

export default function OnboardingPage() {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();

  const [windRating,         setWindRating]         = useState('');
  const [gliderManufacturer, setGliderManufacturer] = useState('');
  const [gliderModel,        setGliderModel]        = useState('');
  const [gliderWeightRating, setGliderWeightRating] = useState<string>('');

  const { data: leaguesData } = useQuery({
    queryKey: ['leagues'],
    queryFn:  leagueApi.list,
    staleTime: 5 * 60 * 1000,
  });

  const saveMutation = useMutation({
    mutationFn: authApi.updateMe,
    onSuccess: (res) => {
      queryClient.setQueryData(AUTH_KEY, res.user);
      const first = leaguesData?.leagues?.[0];
      navigate(first ? `/leagues/${first.slug}` : '/leagues/_/create-league', { replace: true });
    },
  });

  const handleContinue = () => {
    saveMutation.mutate({
      windRating:         windRating         || null,
      gliderManufacturer: gliderManufacturer || null,
      gliderModel:        gliderModel        || null,
      gliderWeightRating: gliderWeightRating ? parseFloat(gliderWeightRating) : null,
    });
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: '2rem',
    }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent)', marginBottom: 8 }}>
            XC League
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>
            Set up your pilot profile
          </div>
          <div style={{ fontSize: '0.9rem', color: 'var(--text2)' }}>
            Tell us about your equipment so your results can be displayed correctly.
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Wind rating */}
          <div>
            <label style={{ marginBottom: 8 }}>
              Wind Rating <span style={{ color: 'var(--error)', marginLeft: 2 }}>*</span>
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {WIND_RATINGS.map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setWindRating(windRating === r ? '' : r)}
                  style={{
                    padding: '0.375rem 0.875rem',
                    borderRadius: '0.375rem',
                    border: `1px solid ${windRating === r ? 'var(--accent)' : 'var(--border)'}`,
                    background: windRating === r ? 'var(--accent)' : 'var(--bg)',
                    color: windRating === r ? '#fff' : 'var(--text2)',
                    fontSize: '0.875rem',
                    fontWeight: windRating === r ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Manufacturer */}
          <div>
            <label>Glider Manufacturer</label>
            <input
              type="text"
              value={gliderManufacturer}
              onChange={e => setGliderManufacturer(e.target.value)}
              placeholder="e.g. Ozone, Advance, Nova"
            />
          </div>

          {/* Model */}
          <div>
            <label>Glider Model</label>
            <input
              type="text"
              value={gliderModel}
              onChange={e => setGliderModel(e.target.value)}
              placeholder="e.g. Zeno 3, Iota 3"
            />
          </div>

          {/* Weight rating */}
          <div>
            <label>Top Rated Weight (kg)</label>
            <input
              type="number"
              min="1"
              step="0.5"
              value={gliderWeightRating}
              onChange={e => setGliderWeightRating(e.target.value)}
              placeholder="e.g. 95"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 }}>
            <button
              className="btn btn-primary"
              onClick={handleContinue}
              disabled={!windRating || saveMutation.isPending}
              style={{ minWidth: 120 }}
            >
              {saveMutation.isPending ? 'Saving…' : 'Get Started'}
            </button>
            {!windRating && (
              <span style={{ fontSize: 13, color: 'var(--text3)' }}>Select a wind rating to continue</span>
            )}
            {saveMutation.isError && (
              <span style={{ fontSize: 13, color: 'var(--error)' }}>Failed to save — please try again</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
