// =============================================================================
// Task Import Modal
//
// Allows a league admin to upload a .xctsk or .cup file to create a task
// with all turnpoints pre-populated.
// =============================================================================

import { useState, useRef, useEffect } from 'react';
import { leagueApi } from '../api/leagues';

interface Props {
  leagueSlug: string;
  seasonId:   string;
  onSuccess:  () => void;
  onClose:    () => void;
}

export default function TaskImportModal({ leagueSlug, seasonId, onSuccess, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [openDate, setOpenDate] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [drag, setDrag] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File | null | undefined) => {
    if (!f) return;
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (ext !== 'xctsk' && ext !== 'cup') {
      setError('Please select a .xctsk or .cup file');
      return;
    }
    setFile(f);
    // Pre-fill name from filename
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setIsImporting(true);
    setError(null);

    try {
      await leagueApi.importTask(leagueSlug, seasonId, file, {
        name: name || undefined,
        openDate: openDate ? openDate + ':00Z' : undefined,
        closeDate: closeDate ? closeDate + ':00Z' : undefined,
      });
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg1)',
        borderRadius: 8,
        padding: '2rem',
        width: '100%',
        maxWidth: 520,
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
            Import Task
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem', color: 'var(--text2)' }}
          >
            ×
          </button>
        </div>

        <p style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '1.5rem' }}>
          Upload a task file to automatically create a task with all turnpoints.
          Supported formats: <strong>.xctsk</strong> (XCTrack), <strong>.cup</strong> (SeeYou Navigator).
        </p>

        {error && (
          <div style={{
            padding: '0.75rem 1rem',
            background: '#fee',
            border: '1px solid #fcc',
            borderRadius: 6,
            color: '#c00',
            fontSize: '0.875rem',
            marginBottom: '1rem',
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* File drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
            onClick={() => !file && fileRef.current?.click()}
            style={{
              border: `2px dashed ${drag ? 'var(--primary)' : 'var(--border)'}`,
              borderRadius: 8,
              padding: '1.5rem',
              textAlign: 'center',
              cursor: file ? 'default' : 'pointer',
              background: drag ? 'var(--bg2)' : 'transparent',
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".xctsk,.cup"
              style={{ display: 'none' }}
              onChange={e => handleFile(e.target.files?.[0])}
            />
            {file ? (
              <div>
                <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>📄</div>
                <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{file.name}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
                  {(file.size / 1024).toFixed(1)} KB
                </div>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setFile(null); setName(''); }}
                  style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#c00', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  ✕ Remove
                </button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📂</div>
                <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>Drop task file here or click to browse</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text3)', marginTop: '0.25rem' }}>.xctsk or .cup</div>
              </div>
            )}
          </div>

          {/* Task name */}
          <div>
            <label style={{ display: 'block', fontWeight: 500, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
              Task Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Defaults to filename"
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: '0.875rem',
                background: 'var(--bg1)',
                color: 'var(--text1)',
              }}
            />
          </div>

          {/* Dates */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 500, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                Open Date & Time
              </label>
              <input
                type="datetime-local"
                value={openDate}
                onChange={e => setOpenDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: '0.875rem',
                  background: 'var(--bg1)',
                  color: 'var(--text1)',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontWeight: 500, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                Close Date & Time
              </label>
              <input
                type="datetime-local"
                value={closeDate}
                onChange={e => setCloseDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: '0.875rem',
                  background: 'var(--bg1)',
                  color: 'var(--text1)',
                }}
              />
            </div>
          </div>

          <p style={{ fontSize: '0.8rem', color: 'var(--text2)', margin: 0 }}>
            Dates can be edited after import. If not set, defaults will be used.
          </p>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', paddingTop: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isImporting}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid var(--border)',
                borderRadius: 4,
                background: 'var(--bg1)',
                cursor: 'pointer',
                fontSize: '0.875rem',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!file || isImporting}
              style={{
                padding: '0.5rem 1.25rem',
                border: 'none',
                borderRadius: 4,
                background: !file || isImporting ? 'var(--border)' : 'var(--primary)',
                color: 'white',
                cursor: !file || isImporting ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              {isImporting ? 'Importing…' : 'Import Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
