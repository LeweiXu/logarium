import { useState, useEffect, useRef } from 'react';
import { getRefreshCounts, startEntryRefresh } from '../../api.jsx';
import { SOURCE_LABEL, enabledSourceList } from './searchSources.js';

// ── RefreshPanel ──────────────────────────────────────────────────────────────
// Bulk version of the detail modal's Refresh button: walk every entry from the
// chosen sources, re-read its source page, and fill in what changed. Only the
// source's own facts are touched (title, medium, year, cover, length, genres,
// source rating); status, rating, progress, notes and lists are left alone.
//
// The picker offers only sources enabled in Console → Media & Search Sources,
// and only those you actually have refreshable entries for.

// Mirrors refresh_service: what a refresh may touch, and what it touches by
// default. Title/medium/origin are off unless you ask, since a provider will
// happily relabel a web novel or rename a series.
const FIELDS = [
  ['cover_url',       'Cover',        true],
  ['total',           'Length',       true],
  ['year',            'Year',         true],
  ['genres',          'Genres',       true],
  ['external_rating', 'Source rating', true],
  ['external_id',     'Source id',    true],
  ['title',           'Title',        false],
  ['medium',          'Type',         false],
  ['origin',          'Origin',       false],
];

export default function RefreshPanel() {
  // stage: 'select' | 'running' | 'done' | 'error'
  const [stage,    setStage]    = useState('select');
  const [counts,   setCounts]   = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [fields,   setFields]   = useState(() => new Set(FIELDS.filter(f => f[2]).map(f => f[0])));
  const [prog,     setProg]     = useState({ processed: 0, total: 0, updated: 0, unchanged: 0, failed: 0, title: '' });
  const [summary,  setSummary]  = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const abortRef = useRef(null);

  // Collapsing the card (or leaving the page) stops the run.
  useEffect(() => () => abortRef.current?.(), []);

  useEffect(() => {
    let cancelled = false;
    getRefreshCounts()
      .then(data => { if (!cancelled) setCounts(data || {}); })
      .catch(() => { if (!cancelled) setCounts({}); });
    return () => { cancelled = true; };
  }, []);

  // Enabled sources that actually have entries to refresh.
  const options = enabledSourceList()
    .map(s => ({ ...s, count: counts?.[s.value] || 0 }))
    .filter(s => s.count > 0);
  const chosenTotal = [...selected].reduce((n, v) => n + (counts?.[v] || 0), 0);

  function toggleField(value) {
    setFields(prev => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  }

  function toggle(value) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  }

  async function start() {
    setStage('running');
    setErrorMsg('');
    setSummary(null);
    setProg({ processed: 0, total: 0, updated: 0, unchanged: 0, failed: 0, title: '' });
    try {
      const { pump, abort } = await startEntryRefresh([...selected], [...fields], event => {
        if (event.type === 'start') {
          setProg(p => ({ ...p, total: event.total }));
        } else if (event.type === 'progress') {
          setProg({
            processed: event.processed, total: event.total, title: event.title,
            updated: event.updated, unchanged: event.unchanged, failed: event.failed,
          });
        } else if (event.type === 'done') {
          setSummary(event);
        }
      });
      abortRef.current = abort;
      await pump();
      setStage('done');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setErrorMsg(err.message || String(err));
      setStage('error');
    } finally {
      abortRef.current = null;
    }
  }

  const pct = prog.total ? Math.round((prog.processed / prog.total) * 100) : 0;

  if (stage === 'running') {
    return (
      <div className="refresh-panel">
        <p className="console-tool-note">
          {prog.processed} / {prog.total} · {prog.title || 'starting…'}
        </p>
        <div className="library-meter refresh-meter">
          <div className="library-meter-fill" style={{ '--completion-pct': `${pct}%` }} />
        </div>
        <p className="console-tool-note">
          {prog.updated} updated · {prog.unchanged} unchanged · {prog.failed} failed
        </p>
      </div>
    );
  }

  if (stage === 'done' && summary) {
    return (
      <div className="refresh-panel">
        <p className="tool-intro">
          Checked {summary.total} {summary.total === 1 ? 'entry' : 'entries'}:{' '}
          <strong>{summary.updated} updated</strong>, {summary.unchanged} already current,{' '}
          {summary.failed} could not be read.
        </p>
        {summary.changes?.length > 0 && (
          <div className="refresh-changes">
            {summary.changes.map((c, i) => (
              <div key={i} className="refresh-change">
                <span className="refresh-change-title">{c.title}</span>
                <span className="refresh-change-fields">
                  {c.fields.map(f => (
                    <span key={f.field} className="refresh-change-field">
                      {f.field}: {f.from ?? 'blank'} &rarr; {f.to}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            {summary.changes_truncated > 0 && (
              <p className="console-tool-note">
                and {summary.changes_truncated} more.
              </p>
            )}
          </div>
        )}
        <div className="refresh-actions">
          <button type="button" className="btn btn-outline" onClick={() => setStage('select')}>
            Refresh something else
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="refresh-panel">
      <p className="tool-intro">
        Re-reads each entry's source page and updates what the source owns: title,
        type, year, cover, length, genres and source rating. Your status, rating,
        progress, notes and lists are never touched.
      </p>

      {errorMsg && <div className="settings-msg settings-msg-error">{errorMsg}</div>}

      {counts === null
        ? <p className="console-tool-note">Loading sources…</p>
        : options.length === 0
        ? <p className="console-tool-note">
            No entries to refresh. Entries need a source URL, and the source has to be
            enabled in Media &amp; Search Sources.
          </p>
        : (
          <>
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
                {options.map(s => {
                  const on = selected.has(s.value);
                  return (
                    <button key={s.value} type="button"
                      className={`source-chip${on ? ' is-on' : ''}`}
                      onClick={() => toggle(s.value)}>
                      <span className="source-box">{on ? '[x]' : '[ ]'}</span>
                      {SOURCE_LABEL[s.value] || s.label} ({s.count})
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="source-select">
              <div className="source-select-head">
                <span className="form-label">Fields to update</span>
              </div>
              <div className="source-grid">
                {FIELDS.map(([value, label]) => {
                  const on = fields.has(value);
                  return (
                    <button key={value} type="button"
                      className={`source-chip${on ? ' is-on' : ''}`}
                      onClick={() => toggleField(value)}>
                      <span className="source-box">{on ? '[x]' : '[ ]'}</span>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="tool-center-action">
              <button className="btn-success" disabled={selected.size === 0 || fields.size === 0} onClick={start}>
                Refresh {chosenTotal || ''} {chosenTotal === 1 ? 'entry' : 'entries'}
              </button>
            </div>
          </>
        )}
    </div>
  );
}
