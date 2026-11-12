import { useState, useEffect, useMemo, useRef } from 'react';
import { BASE } from '../../api.jsx';
import { enabledSourceList } from './searchSources.js';

// ── ResyncPanel ───────────────────────────────────────────────────────────────
// Inline (Console) version of the extension-driven cover resync. The extension
// fetches each selected source first-party (so Cloudflare-gated covers like
// NovelUpdates work) and caches them on the server. The UI lives here; the
// extension does the work headlessly and streams progress back through its bridge.
// Cancels the run if the panel is unmounted (collapsed).

const post = (msg) =>
  window.postMessage({ logarium: true, dir: 'toExt', ...msg }, window.location.origin);

export default function ResyncPanel() {
  // stage: 'select' | 'running' | 'done' | 'error'
  const [stage,    setStage]    = useState('select');
  const sources = useMemo(() => enabledSourceList(), []);
  const [selected, setSelected] = useState(() => (
    new Set(sources.some(s => s.value === 'novelupdates') ? ['novelupdates'] : [])
  ));
  const [prog,     setProg]     = useState({ done: 0, total: 0, cached: 0, updated: 0, failed: 0, current: '' });
  const [errorMsg, setErrorMsg] = useState('');

  const stageRef = useRef(stage);
  stageRef.current = stage;

  // Receive progress relayed from the extension's background worker.
  useEffect(() => {
    function onMsg(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.logarium !== true || d.dir !== 'fromExt') return;
      if (d.type === 'progress') {
        setProg(p => ({ ...p, ...d }));
      } else if (d.type === 'done') {
        setProg(p => ({ ...p, ...d }));
        setStage('done');
      } else if (d.type === 'error') {
        setErrorMsg(d.reason || 'Sync failed');
        setStage('error');
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // If the panel is unmounted mid-run, tell the extension to stop.
  useEffect(() => () => {
    if (stageRef.current === 'running') post({ type: 'cancelSync' });
  }, []);

  function toggle(value) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  }

  function start() {
    const token = localStorage.getItem('auth_token');
    setProg({ done: 0, total: 0, cached: 0, updated: 0, failed: 0, current: '' });
    setStage('running');
    post({ type: 'startSync', sources: [...selected], token, apiBase: BASE });
  }

  function cancel() {
    post({ type: 'cancelSync' });
    setStage('select');
  }

  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;

  return (
    <div className="console-tool-body">
      {stage === 'select' && (
        <>
          <p className="tool-intro">
            The extension fetches each selected source's covers first-party and caches
            them on the server, so they survive hotlink/Cloudflare blocks. NovelUpdates
            entries also have their cover URL re-scraped and fixed.
          </p>

          <div className="source-select">
            <div className="source-select-head">
              <span className="form-label">Sources</span>
              {selected.size > 0 && (
                <button type="button" className="source-select-clear" onClick={() => setSelected(new Set())}>
                  ✕ Clear ({selected.size})
                </button>
              )}
            </div>
            <div className="source-grid">
              {sources.map(s => {
                const on = selected.has(s.value);
                return (
                  <button
                    key={s.value}
                    type="button"
                    className={`source-chip${on ? ' is-on' : ''}`}
                    onClick={() => toggle(s.value)}
                  >
                    <span className="source-box">{on ? '[x]' : '[ ]'}</span>
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="tool-center-action">
            <button className="btn-success" disabled={selected.size === 0} onClick={start}>
              Start Resync
            </button>
          </div>
        </>
      )}

      {(stage === 'running' || stage === 'done') && (
        <>
          <div className="tool-progress-head">
            <span className="tool-progress-title">
              {stage === 'running' ? <span className="loading-dots">Resyncing</span> : 'Done'}
            </span>
            <span className="tool-progress-count">{prog.done} / {prog.total}</span>
          </div>

          <div className="tool-progress-track">
            <div className="tool-progress-fill" style={{ '--tool-progress-pct': `${pct}%` }} />
          </div>

          {stage === 'running' && prog.current && (
            <div className="tool-current-line">
              {prog.current}
            </div>
          )}

          <div className="tool-stat-row">
            <div className="stat-box"><span className="stat-val">{prog.cached}</span><span className="stat-lbl">Cached</span></div>
            <div className="stat-box"><span className="stat-val">{prog.updated}</span><span className="stat-lbl">URL fixed</span></div>
            <div className="stat-box"><span className="stat-val">{prog.failed}</span><span className="stat-lbl">Failed</span></div>
          </div>

          {stage === 'running' && (
            <>
              <div className="tool-cancel">
                <button className="icon-btn danger tool-small-danger" onClick={cancel}>
                  Cancel
                </button>
              </div>
              <p className="tool-note">
                NovelUpdates entries open each series page briefly in the background — this can take a while.
              </p>
            </>
          )}

          {stage === 'done' && (
            <div className="tool-cancel">
              <button className="icon-btn" onClick={() => setStage('select')}>Run Again</button>
            </div>
          )}
        </>
      )}

      {stage === 'error' && (
        <div className="import-stage-error">
          <p className="tool-error-title">{errorMsg}</p>
          <p className="tool-error-help">
            Make sure the browser extension is installed and you're signed in.
          </p>
          <button className="icon-btn" onClick={() => setStage('select')}>Back</button>
        </div>
      )}
    </div>
  );
}
