import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { leagueApi, type LeagueMember } from '../api/leagues';
import { useLeague } from '../hooks/useLeague';

export default function LeagueSettingsPage() {
  const { leagueSlug } = useLeague();
  const queryClient = useQueryClient();
  const [selectedMember, setSelectedMember] = useState<LeagueMember | null>(null);
  const [action, setAction] = useState<'promote' | 'demote' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['leagues', leagueSlug, 'members'],
    queryFn: () => leagueApi.listMembers(leagueSlug),
  });

  const promoteMutation = useMutation({
    mutationFn: (userId: string) => leagueApi.promoteMember(leagueSlug, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'members'] });
      setSelectedMember(null);
      setAction(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to promote member');
    },
  });

  const demoteMutation = useMutation({
    mutationFn: (userId: string) => leagueApi.demoteMember(leagueSlug, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'members'] });
      setSelectedMember(null);
      setAction(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to demote member');
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => leagueApi.removeMember(leagueSlug, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leagues', leagueSlug, 'members'] });
      setSelectedMember(null);
      setAction(null);
      setError(null);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to remove member');
    },
  });

  const handleAction = () => {
    if (!selectedMember) return;
    
    switch (action) {
      case 'promote':
        promoteMutation.mutate(selectedMember.userId);
        break;
      case 'demote':
        demoteMutation.mutate(selectedMember.userId);
        break;
      case 'remove':
        removeMutation.mutate(selectedMember.userId);
        break;
    }
  };

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
          Error loading members: {queryError.message}
        </div>
      </div>
    );
  }

  const members = data?.members || [];
  const admins = members.filter(m => m.role === 'admin');
  const pilots = members.filter(m => m.role === 'pilot');

  return (
    <div style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          League Settings
        </h1>
        <p style={{ color: 'var(--text2)' }}>
          Manage members and administrators for {leagueSlug}
        </p>
        
        {error && (
          <div style={{ 
            marginTop: '1rem',
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
      </header>

      {/* Admins */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          Administrators ({admins.length})
        </h2>
        <div style={{ 
          border: '1px solid var(--border)', 
          borderRadius: 8,
          overflow: 'hidden'
        }}>
          {admins.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text2)' }}>
              No administrators
            </div>
          ) : (
            admins.map((member, i) => (
              <div
                key={member.id}
                style={{
                  padding: '1rem',
                  borderBottom: i < admins.length - 1 ? '1px solid var(--border)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--bg2)'
                }}
              >
                <div>
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>
                    {member.displayName}
                  </div>
                  <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                    {member.email}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text3)', marginTop: '0.25rem' }}>
                    Joined {new Date(member.joinedAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => {
                      setSelectedMember(member);
                      setAction('demote');
                    }}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      background: 'var(--bg1)',
                      color: 'var(--text2)',
                      cursor: 'pointer',
                      fontSize: '0.875rem'
                    }}
                  >
                    Demote
                  </button>
                  <button
                    onClick={() => {
                      setSelectedMember(member);
                      setAction('remove');
                    }}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid var(--danger, #dc2626)',
                      borderRadius: 4,
                      background: 'transparent',
                      color: 'var(--danger, #dc2626)',
                      cursor: 'pointer',
                      fontSize: '0.875rem'
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Pilots */}
      <section>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          Members ({pilots.length})
        </h2>
        <div style={{ 
          border: '1px solid var(--border)', 
          borderRadius: 8,
          overflow: 'hidden'
        }}>
          {pilots.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text2)' }}>
              No members yet
            </div>
          ) : (
            pilots.map((member, i) => (
              <div
                key={member.id}
                style={{
                  padding: '1rem',
                  borderBottom: i < pilots.length - 1 ? '1px solid var(--border)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <div>
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>
                    {member.displayName}
                  </div>
                  <div style={{ fontSize: '0.875rem', color: 'var(--text2)' }}>
                    {member.email}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text3)', marginTop: '0.25rem' }}>
                    Joined {new Date(member.joinedAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => {
                      setSelectedMember(member);
                      setAction('promote');
                    }}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid var(--primary)',
                      borderRadius: 4,
                      background: 'var(--primary)',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '0.875rem'
                    }}
                  >
                    Promote to Admin
                  </button>
                  <button
                    onClick={() => {
                      setSelectedMember(member);
                      setAction('remove');
                    }}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      background: 'transparent',
                      color: 'var(--text2)',
                      cursor: 'pointer',
                      fontSize: '0.875rem'
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Confirmation Dialog */}
      {selectedMember && action && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'var(--bg1)',
            padding: '2rem',
            borderRadius: 8,
            maxWidth: 400,
            width: '90%'
          }}>
            <h3 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>
              {action === 'promote' && `Promote ${selectedMember.displayName}?`}
              {action === 'demote' && `Demote ${selectedMember.displayName}?`}
              {action === 'remove' && `Remove ${selectedMember.displayName}?`}
            </h3>
            <p style={{ marginBottom: '1.5rem', color: 'var(--text2)' }}>
              {action === 'promote' && 'This user will be able to manage league members and settings.'}
              {action === 'demote' && 'This user will no longer have admin privileges for this league.'}
              {action === 'remove' && 'This user will be removed from the league and lose access to all league data.'}
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setSelectedMember(null);
                  setAction(null);
                }}
                style={{
                  padding: '0.5rem 1rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--bg2)',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleAction}
                disabled={promoteMutation.isPending || demoteMutation.isPending || removeMutation.isPending}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  borderRadius: 4,
                  background: action === 'remove' ? 'var(--danger, #dc2626)' : 'var(--primary)',
                  color: 'white',
                  cursor: 'pointer'
                }}
              >
                {(promoteMutation.isPending || demoteMutation.isPending || removeMutation.isPending) 
                  ? 'Processing...' 
                  : action === 'promote' 
                    ? 'Promote' 
                    : action === 'demote' 
                      ? 'Demote' 
                      : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
