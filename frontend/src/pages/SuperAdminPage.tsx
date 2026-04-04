import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { adminApi, type LeagueSummary, type User } from '../api/admin';

export default function SuperAdminPage() {
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [leagueToDelete, setLeagueToDelete] = useState<LeagueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    data,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: adminApi.listUsers,
  });

  const { data: leaguesData, isLoading: leaguesLoading } = useQuery({
    queryKey: ['admin', 'leagues'],
    queryFn: adminApi.listLeagues,
  });

  const promoteMutation = useMutation({
    mutationFn: (userId: string) => adminApi.promoteToSuperAdmin(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setSelectedUser(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to promote user');
    },
  });

  const demoteMutation = useMutation({
    mutationFn: (userId: string) => adminApi.demoteFromSuperAdmin(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setSelectedUser(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to demote user');
    },
  });

  const deleteLeagueMutation = useMutation({
    mutationFn: (slug: string) => adminApi.deleteLeague(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'leagues'] });
      queryClient.invalidateQueries({ queryKey: ['leagues'] });
      setLeagueToDelete(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to delete league');
      setLeagueToDelete(null);
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
        <div
          style={{
            padding: '1rem',
            background: '#fee',
            border: '1px solid #fcc',
            borderRadius: 8,
            color: '#c00',
          }}
        >
          Error loading users: {queryError.message}
        </div>
      </div>
    );
  }

  const users = data?.users || [];
  const superAdmins = users.filter((u) => u.isAdmin);
  const regularUsers = users.filter((u) => !u.isAdmin);

  return (
    <div style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>Super Admin Panel</h1>
        <p style={{ color: 'var(--text2)' }}>Manage platform administrators and view system users</p>

        {error && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem 1rem',
              background: '#fee',
              border: '1px solid #fcc',
              borderRadius: 6,
              color: '#c00',
              fontSize: '0.875rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
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
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}
      </header>

      {/* Leagues */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          Leagues ({leaguesData?.leagues.length ?? 0})
        </h2>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {leaguesLoading ? (
            <div style={{ padding: '1rem' }}>
              <div className="shimmer" style={{ height: 40, borderRadius: 4 }} />
            </div>
          ) : (leaguesData?.leagues ?? []).length === 0 ? (
            <div style={{ padding: '1rem', color: 'var(--text3)', fontSize: '0.875rem' }}>No leagues</div>
          ) : (
            (leaguesData?.leagues ?? []).map((league, i) => (
              <div
                key={league.id}
                style={{
                  padding: '1rem',
                  borderBottom: i < (leaguesData?.leagues.length ?? 0) - 1 ? '1px solid var(--border)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--bg2)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 500, marginBottom: '0.2rem' }}>{league.name}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                    /{league.slug}
                    {league.shortDescription && (
                      <span style={{ marginLeft: 8, color: 'var(--text3)' }}>· {league.shortDescription}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setLeagueToDelete(league)}
                  style={{
                    padding: '0.375rem 0.75rem',
                    border: '1px solid rgba(239,68,68,0.4)',
                    borderRadius: 4,
                    background: 'rgba(239,68,68,0.08)',
                    color: '#f87171',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Super Admins */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          Super Administrators ({superAdmins.length})
        </h2>
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {superAdmins.map((user, i) => (
            <div
              key={user.id}
              style={{
                padding: '1rem',
                borderBottom: i < superAdmins.length - 1 ? '1px solid var(--border)' : 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: 'var(--bg2)',
              }}
            >
              <div>
                <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{user.displayName}</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>{user.email}</div>
              </div>
              <button
                onClick={() => setSelectedUser(user)}
                disabled={demoteMutation.isPending}
                style={{
                  padding: '0.5rem 1rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--bg1)',
                  color: 'var(--text2)',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                Manage
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Regular Users */}
      <section>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          All Users ({regularUsers.length})
        </h2>
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {regularUsers.map((user, i) => (
            <div
              key={user.id}
              style={{
                padding: '1rem',
                borderBottom: i < regularUsers.length - 1 ? '1px solid var(--border)' : 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{user.displayName}</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>{user.email}</div>
              </div>
              <button
                onClick={() => promoteMutation.mutate(user.id)}
                disabled={promoteMutation.isPending}
                style={{
                  padding: '0.5rem 1rem',
                  border: '1px solid var(--primary)',
                  borderRadius: 4,
                  background: 'var(--primary)',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                Promote to Admin
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Delete league confirm */}
      {leagueToDelete && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{ background: 'var(--bg1)', padding: '2rem', borderRadius: 8, maxWidth: 400, width: '90%' }}>
            <h3 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>Delete "{leagueToDelete.name}"?</h3>
            <p style={{ marginBottom: '1.5rem', color: 'var(--text2)', fontSize: '0.875rem' }}>
              This will permanently remove the league and all associated data. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setLeagueToDelete(null)}
                style={{
                  padding: '0.5rem 1rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--bg2)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => deleteLeagueMutation.mutate(leagueToDelete.slug)}
                disabled={deleteLeagueMutation.isPending}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  borderRadius: 4,
                  background: '#dc2626',
                  color: 'white',
                  cursor: 'pointer',
                }}
              >
                {deleteLeagueMutation.isPending ? 'Deleting…' : 'Delete League'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      {selectedUser && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--bg1)',
              padding: '2rem',
              borderRadius: 8,
              maxWidth: 400,
              width: '90%',
            }}
          >
            <h3 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>Demote {selectedUser.displayName}?</h3>
            <p style={{ marginBottom: '1.5rem', color: 'var(--text2)' }}>
              This will remove super admin privileges from this user. They will no longer have platform-wide
              administrative access.
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setSelectedUser(null)}
                style={{
                  padding: '0.5rem 1rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--bg2)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => demoteMutation.mutate(selectedUser.id)}
                disabled={demoteMutation.isPending}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  borderRadius: 4,
                  background: 'var(--danger, #dc2626)',
                  color: 'white',
                  cursor: 'pointer',
                }}
              >
                {demoteMutation.isPending ? 'Demoting...' : 'Demote'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
