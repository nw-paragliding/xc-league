// =============================================================================
// Task Export Modal
//
// Shows download buttons (.xctsk, .cup) and QR codes (XCTrack deep-link,
// HTTPS download URL) for a published task.
// =============================================================================

import { useState, useEffect } from 'react';
import { leagueApi, type Task } from '../api/leagues';

interface Props {
  task:       Task;
  leagueSlug: string;
  onClose:    () => void;
}

export default function TaskExportModal({ task, leagueSlug, onClose }: Props) {
  const seasonId = task.seasonId;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const [downloading, setDownloading] = useState<'xctsk' | 'cup' | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [qrError, setQrError] = useState<'too_large' | 'load_error' | null>(null);

  const qrSrc = seasonId
    ? leagueApi.getTaskQrUrl(leagueSlug, seasonId, task.id, 'xctrack', 'xctsk')
    : null;

  useEffect(() => { setQrError(null); }, [qrSrc]);

  const handleQrError = async () => {
    if (!qrSrc) return;
    try {
      const res = await fetch(qrSrc);
      if (res.status === 422) {
        setQrError('too_large');
      } else {
        setQrError('load_error');
      }
    } catch {
      setQrError('load_error');
    }
  };

  const handleDownload = async (format: 'xctsk' | 'cup') => {
    if (!seasonId) { setDownloadError('Season ID unavailable — please refresh and try again.'); return; }
    setDownloading(format);
    setDownloadError(null);
    try {
      const blob = await leagueApi.downloadTask(leagueSlug, seasonId, task.id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${task.name.replace(/[^a-z0-9]/gi, '_')}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setDownloadError(err.message || 'Download failed');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '1rem',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg1)',
        borderRadius: 12,
        width: '100%',
        maxWidth: 480,
        maxHeight: '95vh',
        overflowY: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        border: '1px solid var(--border)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 3 }}>
              Get Task
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
              {task.name}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: 6, cursor: 'pointer',
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, color: 'var(--text2)',
            }}
          >
            ×
          </button>
        </div>

        {/* QR Code — fills width */}
        <div style={{ padding: '14px 20px 0' }}>
          {qrError ? (
            <div style={{
              borderRadius: 10,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
              padding: '32px 24px',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>⚠</div>
              {qrError === 'too_large' ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                    Task too large for QR code
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                    Too many turnpoints to encode. Use the download buttons below.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                    QR code unavailable
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                    Use the download buttons below to get the task file.
                  </div>
                </>
              )}
            </div>
          ) : qrSrc ? (
            <>
              <div style={{
                borderRadius: 10,
                overflow: 'hidden',
                background: 'white',
                lineHeight: 0,
              }}>
                <img
                  key={qrSrc}
                  src={qrSrc}
                  alt="Task QR code"
                  onError={handleQrError}
                  style={{ display: 'block', width: '100%', height: 'auto', imageRendering: 'pixelated' }}
                />
              </div>
              <div style={{
                textAlign: 'center', padding: '10px 0 4px',
                fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)',
              }}>
                Scan with XCTrack or FlySkHy to load task directly
              </div>
            </>
          ) : null}
        </div>

        {/* Download buttons */}
        <div style={{ padding: '14px 20px 20px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 8 }}>
            Download File
          </div>

          {downloadError && (
            <div style={{
              padding: '8px 12px', marginBottom: 8,
              background: 'rgba(224,82,82,0.08)', border: '1px solid rgba(224,82,82,0.2)',
              borderRadius: 6, fontSize: 12, color: 'var(--danger)',
            }}>
              {downloadError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            {(['xctsk', 'cup'] as const).map(fmt => (
              <button
                key={fmt}
                onClick={() => handleDownload(fmt)}
                disabled={downloading !== null}
                style={{
                  flex: 1, padding: '8px 12px',
                  border: '1px solid var(--border)', borderRadius: 6,
                  background: 'var(--bg2)', color: 'var(--text2)',
                  cursor: downloading ? 'not-allowed' : 'pointer',
                  fontSize: 12, fontWeight: 500, textAlign: 'center' as const,
                  opacity: downloading && downloading !== fmt ? 0.5 : 1,
                }}
              >
                {downloading === fmt ? '↓ Downloading…' : `↓ .${fmt} ${fmt === 'xctsk' ? '(XCTrack)' : '(SeeYou)'}`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
