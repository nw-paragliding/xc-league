// =============================================================================
// BulkImportModal — import all tasks from a .cup waypoint/task file
// Two-step flow:
//   1. Drop the .cup file → preview API returns all tasks found
//   2. Configure name + dates per task → bulk-import creates them all
// =============================================================================

import { useState, useRef, useEffect } from 'react';
import { leagueApi, type CupPreviewTask } from '../api/leagues';

interface TaskRow {
  index:    number;
  name:     string;
  openDate:  string;
  closeDate: string;
  selected: boolean;
  turnpointCount: number;
}

interface Props {
  leagueSlug:        string;
  seasonId:          string;
  defaultOpenDate?:  string;
  defaultCloseDate?: string;
  onSuccess:         () => void;
  onClose:           () => void;
}

export default function BulkImportModal({ leagueSlug, seasonId, defaultOpenDate, defaultCloseDate, onSuccess, onClose }: Props) {
  const fmt = (iso?: string, defaultTime = '00:00') => {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `${iso}T${defaultTime}`;
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const [file,        setFile]        = useState<File | null>(null);
  const [tasks,       setTasks]       = useState<TaskRow[]>([]);
  const [step,        setStep]        = useState<'upload' | 'configure'>('upload');
  const [drag,        setDrag]        = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.cup')) {
      setError('Please select a .cup file');
      return;
    }
    setError(null);
    setFile(f);
    setLoading(true);
    try {
      const { tasks: previewed } = await leagueApi.cupPreview(leagueSlug, seasonId, f);
      if (previewed.length === 0) {
        setError('No tasks found in this .cup file');
        setFile(null);
        setLoading(false);
        return;
      }
      setTasks(buildRows(previewed));
      setStep('configure');
    } catch (err: any) {
      setError(err.message || 'Failed to preview file');
      setFile(null);
    } finally {
      setLoading(false);
    }
  };

  const buildRows = (previewed: CupPreviewTask[]): TaskRow[] =>
    previewed.map(t => ({
      index:    t.index,
      name:     t.name,
      openDate:  fmt(defaultOpenDate),
      closeDate: fmt(defaultCloseDate, '23:59'),
      selected:  true,
      turnpointCount: t.turnpointCount,
    }));

  const updateRow = (idx: number, patch: Partial<TaskRow>) => {
    setTasks(rows => rows.map(r => r.index === idx ? { ...r, ...patch } : r));
  };

  const handleImport = async () => {
    const selected = tasks.filter(t => t.selected);
    if (selected.length === 0) { setError('Select at least one task'); return; }
    setLoading(true);
    setError(null);
    try {
      const payload = selected.map(t => ({
        index:     t.index,
        name:      t.name || undefined,
        openDate:  t.openDate  ? new Date(t.openDate).toISOString()  : undefined,
        closeDate: t.closeDate ? new Date(t.closeDate).toISOString() : undefined,
      }));
      await leagueApi.bulkImport(leagueSlug, seasonId, file!, payload);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  const selectedCount = tasks.filter(t => t.selected).length;

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '1.5rem',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg1)',
        borderRadius: 8,
        padding: '2rem',
        width: '100%',
        maxWidth: step === 'configure' ? 680 : 520,
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
            {step === 'upload' ? 'Bulk Import from .cup' : `Configure Tasks (${file?.name})`}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem', color: 'var(--text2)' }}>×</button>
        </div>

        {error && (
          <div style={{
            padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
            color: '#f87171', fontSize: '0.875rem', marginBottom: '1rem',
          }}>
            {error}
          </div>
        )}

        {/* Step 1: upload */}
        {step === 'upload' && (
          <div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '1.5rem' }}>
              Drop a SeeYou <strong>.cup</strong> waypoint file that contains a "Related Tasks" section.
              All tasks in the file will be detected and you can configure dates before importing.
            </p>
            <div
              onDragOver={e => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${drag ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 8, padding: '2.5rem', textAlign: 'center',
                cursor: loading ? 'wait' : 'pointer',
                background: drag ? 'var(--bg2)' : 'transparent',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <input ref={fileRef} type="file" accept=".cup" style={{ display: 'none' }}
                onChange={e => handleFile(e.target.files?.[0])} />
              {loading ? (
                <div style={{ color: 'var(--text2)', fontSize: '0.875rem' }}>Parsing file…</div>
              ) : (
                <>
                  <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📂</div>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>Drop .cup file here or click to browse</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text3)', marginTop: '0.25rem' }}>SeeYou Navigator .cup format</div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Step 2: configure */}
        {step === 'configure' && (
          <div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text2)', marginBottom: '1rem' }}>
              {tasks.length} task{tasks.length !== 1 ? 's' : ''} found. Select which to import and set dates for each.
              Dates can be edited after import.
            </p>

            {/* Column headers */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '20px 1fr 170px 170px',
              gap: '0.5rem',
              padding: '0.4rem 0.5rem',
              fontSize: '0.7rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text3)',
              fontFamily: 'var(--font-mono)',
              borderBottom: '1px solid var(--border)',
              marginBottom: '0.25rem',
            }}>
              <span />
              <span>Task</span>
              <span>Open</span>
              <span>Close</span>
            </div>

            {tasks.map(row => (
              <div key={row.index} style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr 170px 170px',
                gap: '0.5rem',
                alignItems: 'center',
                padding: '0.5rem',
                borderRadius: 4,
                background: row.selected ? 'var(--bg2)' : 'transparent',
                marginBottom: 4,
                opacity: row.selected ? 1 : 0.45,
              }}>
                <input
                  type="checkbox"
                  checked={row.selected}
                  onChange={e => updateRow(row.index, { selected: e.target.checked })}
                  style={{ width: 14, height: 14, cursor: 'pointer', accentColor: 'var(--primary)' }}
                />
                <div>
                  <input
                    value={row.name}
                    onChange={e => updateRow(row.index, { name: e.target.value })}
                    disabled={!row.selected}
                    style={{
                      width: '100%', padding: '4px 6px',
                      border: '1px solid var(--border)', borderRadius: 4,
                      fontSize: '0.8125rem', background: 'var(--bg1)',
                      color: 'var(--text)', boxSizing: 'border-box',
                    }}
                  />
                  <div style={{ fontSize: '0.7rem', color: 'var(--text3)', marginTop: 2 }}>
                    {row.turnpointCount} turnpoint{row.turnpointCount !== 1 ? 's' : ''}
                  </div>
                </div>
                <input
                  type="datetime-local"
                  value={row.openDate}
                  onChange={e => updateRow(row.index, { openDate: e.target.value })}
                  disabled={!row.selected}
                  style={{
                    width: '100%', padding: '4px 6px',
                    border: '1px solid var(--border)', borderRadius: 4,
                    fontSize: '0.75rem', background: 'var(--bg2)',
                    color: 'var(--text)', colorScheme: 'dark', boxSizing: 'border-box',
                  }}
                />
                <input
                  type="datetime-local"
                  value={row.closeDate}
                  onChange={e => updateRow(row.index, { closeDate: e.target.value })}
                  disabled={!row.selected}
                  style={{
                    width: '100%', padding: '4px 6px',
                    border: '1px solid var(--border)', borderRadius: 4,
                    fontSize: '0.75rem', background: 'var(--bg2)',
                    color: 'var(--text)', colorScheme: 'dark', boxSizing: 'border-box',
                  }}
                />
              </div>
            ))}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', paddingTop: '1rem', borderTop: '1px solid var(--border)', marginTop: '0.75rem' }}>
              <button
                onClick={() => { setStep('upload'); setFile(null); setTasks([]); setError(null); }}
                disabled={loading}
                style={{
                  padding: '0.5rem 1rem',
                  border: '1px solid var(--border)', borderRadius: 4,
                  background: 'var(--bg2)', color: 'var(--text)',
                  cursor: 'pointer', fontSize: '0.875rem',
                }}
              >
                ← Back
              </button>
              <button
                onClick={handleImport}
                disabled={loading || selectedCount === 0}
                style={{
                  padding: '0.5rem 1.25rem',
                  border: 'none', borderRadius: 4,
                  background: loading || selectedCount === 0 ? 'var(--border)' : 'var(--primary)',
                  color: 'white',
                  cursor: loading || selectedCount === 0 ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem', fontWeight: 500,
                }}
              >
                {loading ? 'Importing…' : `Import ${selectedCount} Task${selectedCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
