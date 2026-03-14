import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { leagueApi } from '../api/leagues';

interface CreateLeaguePageProps {
  onSuccess?: () => void;
}

export default function CreateLeaguePage({ onSuccess }: CreateLeaguePageProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [error, setError] = useState('');

  const createMutation = useMutation({
    mutationFn: leagueApi.create,
    onSuccess: (data) => {
      // Reset form
      setName('');
      setSlug('');
      setDescription('');
      setLogoUrl('');
      setError('');
      
      // Show success message
      alert(`League "${data.league.name}" created successfully!`);
      
      // Call the callback if provided
      if (onSuccess) {
        onSuccess();
      }
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to create league');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setError('Slug must be lowercase letters, numbers, and hyphens only');
      return;
    }

    createMutation.mutate({
      name,
      slug,
      description: description || undefined,
      logo_url: logoUrl || undefined,
    });
  };

  // Auto-generate slug from name
  const handleNameChange = (value: string) => {
    setName(value);
    if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    }
  };

  return (
    <div style={{ padding: '2rem', maxWidth: 600, margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          Create New League
        </h1>
        <p style={{ color: 'var(--text2)' }}>
          Start a new paragliding competition league. You'll become the first admin.
        </p>
      </header>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {/* Name */}
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
            League Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="e.g., Pacific Northwest XC"
            required
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '1rem',
              background: 'var(--bg1)',
              color: 'var(--text1)'
            }}
          />
        </div>

        {/* Slug */}
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
            URL Slug *
          </label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="e.g., pnw-xc-2026"
            required
            pattern="[a-z0-9-]+"
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '1rem',
              background: 'var(--bg1)',
              color: 'var(--text1)'
            }}
          />
          <div style={{ fontSize: '0.875rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
            This will be your league's URL: /leagues/{slug}
          </div>
        </div>

        {/* Description */}
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of your league..."
            rows={4}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '1rem',
              background: 'var(--bg1)',
              color: 'var(--text1)',
              fontFamily: 'inherit',
              resize: 'vertical'
            }}
          />
        </div>

        {/* Logo URL */}
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
            Logo URL (optional)
          </label>
          <input
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://example.com/logo.png"
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: '1rem',
              background: 'var(--bg1)',
              color: 'var(--text1)'
            }}
          />
        </div>

        {/* Error */}
        {error && (
          <div style={{
            padding: '1rem',
            background: 'var(--danger-bg, #fee)',
            border: '1px solid var(--danger, #dc2626)',
            borderRadius: 4,
            color: 'var(--danger, #dc2626)'
          }}>
            {error}
          </div>
        )}

        {/* Submit */}
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => window.history.back()}
            style={{
              padding: '0.75rem 1.5rem',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg2)',
              cursor: 'pointer',
              fontSize: '1rem'
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending || !name || !slug}
            style={{
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: 4,
              background: createMutation.isPending || !name || !slug ? 'var(--border)' : 'var(--primary)',
              color: 'white',
              cursor: createMutation.isPending || !name || !slug ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 500
            }}
          >
            {createMutation.isPending ? 'Creating...' : 'Create League'}
          </button>
        </div>
      </form>
    </div>
  );
}
