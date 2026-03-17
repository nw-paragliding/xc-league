import { useAuth, AUTH_KEY } from '../hooks/useAuth';
import { useStandings } from '../hooks/useStandings';
import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi } from '../api/auth';

function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

const WIND_RATINGS = ['A', 'B', 'C', 'D', 'CCC'] as const;

export default function ProfilePage() {
  const { user, logout, login } = useAuth();
  const { data: standingsData } = useStandings();
  const queryClient = useQueryClient();

  const [windRating,         setWindRating]         = useState('');
  const [gliderManufacturer, setGliderManufacturer] = useState('');
  const [gliderModel,        setGliderModel]        = useState('');
  const [gliderWeightRating, setGliderWeightRating] = useState<string>('');
  const initialized = useRef(false);

  // Populate form once user data is available
  useEffect(() => {
    if (user && !initialized.current) {
      initialized.current = true;
      setWindRating(user.windRating ?? '');
      setGliderManufacturer(user.gliderManufacturer ?? '');
      setGliderModel(user.gliderModel ?? '');
      setGliderWeightRating(user.gliderWeightRating != null ? String(user.gliderWeightRating) : '');
    }
  }, [user]);

  const updateMutation = useMutation({
    mutationFn: authApi.updateMe,
    onSuccess: (res) => queryClient.setQueryData(AUTH_KEY, res.user),
  });

  const saveEquipment = () => {
    updateMutation.mutate({
      windRating:         windRating         || null,
      gliderManufacturer: gliderManufacturer || null,
      gliderModel:        gliderModel        || null,
      gliderWeightRating: gliderWeightRating ? parseFloat(gliderWeightRating) : null,
    });
  };

  const savedWeight = user?.gliderWeightRating != null ? String(user.gliderWeightRating) : '';
  const equipmentDirty =
    (user?.windRating         ?? '') !== windRating         ||
    (user?.gliderManufacturer ?? '') !== gliderManufacturer ||
    (user?.gliderModel        ?? '') !== gliderModel        ||
    savedWeight                       !== gliderWeightRating;

  if (!user) {
    return (
      <div style={{ padding: '80px 36px', textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 16 }}>👤</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Sign in to view profile</div>
        <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 24 }}>
          See your standings, results, and flight history
        </div>
        <button className="btn btn-primary" onClick={login}>Continue with Google</button>
      </div>
    );
  }

  const myStanding = standingsData?.standings.find(s => s.pilotId === user.id);

  return (
    <div className="fade-in">
      <div className="page-header">
        <div className="page-title">Pilot Profile</div>
      </div>

      <div className="page-body" style={{ maxWidth: 680 }}>
        {/* Hero */}
        <div className="profile-hero">
          <div className="avatar-lg">{initials(user.displayName)}</div>
          <div style={{ flex: 1 }}>
            <div className="profile-name">{user.displayName}</div>
            <div className="profile-meta">{user.email}</div>
            {myStanding && (
              <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)' }}>Rank</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--gold)' }}>#{myStanding.rank}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)' }}>Points</div>
                  <div style={{ fontSize: 20, fontWeight: 800 }}>{myStanding.totalPoints.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)' }}>Tasks Flown</div>
                  <div style={{ fontSize: 20, fontWeight: 800 }}>{myStanding.tasksFlown}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)' }}>Goals</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--sky)' }}>{myStanding.tasksWithGoal}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Equipment */}
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 12 }}>
          Equipment
        </div>
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Wind rating */}
            <div>
              <label style={{ marginBottom: 8 }}>Wind Rating</label>
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {equipmentDirty && (
                <button
                  className="btn btn-primary"
                  onClick={saveEquipment}
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save Equipment'}
                </button>
              )}
              {!equipmentDirty && updateMutation.isSuccess && (
                <span style={{ fontSize: 13, color: 'var(--success)' }}>Saved ✓</span>
              )}
              {updateMutation.isError && (
                <span style={{ fontSize: 13, color: 'var(--error)' }}>Failed to save</span>
              )}
            </div>
          </div>
        </div>

        {/* Account actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn btn-secondary"
            onClick={logout}
            style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
