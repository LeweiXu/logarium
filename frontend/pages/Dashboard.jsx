import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRevalidateOnFocus } from '../hooks.jsx';
import {
  useDashboardBootstrap, useEntryMutations,
  prefetchEntriesWithCovers, invalidateEntryData, syncUpdatedEntry, syncDeletedEntry,
  revalidateLibraryRevision,
} from '../data/hooks.jsx';
import { defaultLibraryParams } from '../data/keys.js';
import { coverImgUrl, prefetchFullCover } from '../api.jsx';
import { statusLabel, badgeClass, fmtDate, progressLabel, progressPercent, timeAgo, STATUSES, ORIGINS, logDotClass, onCoverErrorPlaceholder, tableGapVars } from '../utils.jsx';
import AddEntryModal from './components/AddEntryModal.jsx';
import EntryDetailModal from './components/EntryDetailModal.jsx';
import { useShare } from '../share.jsx';
import { SkeletonActivity, SkeletonLine, SkeletonSidebarRows, SkeletonStatGrid, SkeletonTable } from './components/Skeletons.jsx';
import ExtensionUpdateLink from './components/ExtensionUpdateLink.jsx';
import { usePreferences, DEFAULT_UI } from '../preferences.jsx';
import CustomSelect from './components/CustomSelect.jsx';

// Canonical column order + labels shared by every dashboard table. Which of
// these actually render is decided per-table by the saved column preference.
const DASH_COL_ORDER = ['medium', 'year', 'progress', 'completed', 'updated', 'status', 'rating'];
const DASH_COL_META = {
  medium:    { label: 'Type',      cls: 'col-medium' },
  year:      { label: 'Year',      cls: 'col-year' },
  progress:  { label: 'Progress',  cls: 'col-progress' },
  completed: { label: 'Completed', cls: 'col-completed' },
  updated:   { label: 'Updated',   cls: 'col-updated' },
  status:    { label: 'Status',    cls: 'col-status' },
  rating:    { label: 'Rating',    cls: 'col-rating' },
};

// ── Adaptive split measurement ──────────────────────────────────────────────
// The two top tables (Current / Planned) use a fixed-title layout: the title
// column soaks up all the slack while the data columns stay packed at content
// width. A long title in one table forces the user to hand-tune the split so
// that table gets more room. Instead we measure how much width each table
// actually needs and hand out the leftover slack evenly, so the gap after the
// longest title ends up roughly the same on both sides.
let _measureCanvas = null;
function measureTextWidth(text, font) {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}
function fontOf(el) {
  const cs = getComputedStyle(el);
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}

// Width (px) a single dashboard table needs to show its longest title with no
// leftover slack: title-cell padding + cover + cover gap + longest title text +
// the data columns at their content width (with the elastic inter-column gap
// stripped out, since that gap *is* the slack we're balancing).
function tableNeed(table) {
  const names = table.querySelectorAll('.media-name');
  const row = table.querySelector('tbody tr');
  if (!names.length || !row) return null;

  const font = fontOf(names[0]);
  let maxText = 0;
  names.forEach(n => { maxText = Math.max(maxText, measureTextWidth(n.textContent, font)); });

  const cells = Array.from(row.children);
  const titleCell = cells[0];
  const dataCells = cells.slice(1);

  const tcs = getComputedStyle(titleCell);
  const titlePad = parseFloat(tcs.paddingLeft) + parseFloat(tcs.paddingRight);
  const cover = table.querySelector('.cover-thumb');
  const coverW = cover ? cover.offsetWidth : 28;
  const coverCell = table.querySelector('.cover-cell');
  const coverGap = coverCell ? (parseFloat(getComputedStyle(coverCell).gap) || 0) : 10;

  let dataWidth = 0;
  if (dataCells.length) {
    const gap = parseFloat(getComputedStyle(dataCells[0]).paddingLeft) || 0;
    dataCells.forEach(c => { dataWidth += c.offsetWidth; });
    dataWidth -= gap * dataCells.length;
  }

  return titlePad + coverW + coverGap + maxText + dataWidth;
}

function CoverThumb({ url, title, sourceUrl }) {
  return (
    <div className="cover-thumb">
      {url && (
        <img src={url} alt={title}
          loading="eager"
          referrerPolicy="no-referrer"
          data-cover-src={sourceUrl || undefined}
          onError={onCoverErrorPlaceholder} />
      )}
    </div>
  );
}

export default function DashboardAlt({ onFilterChange }) {
  const { prefs } = usePreferences();
  const dash = prefs.dashboard || DEFAULT_UI.dashboard;
  const sidebarClass = `${dash.sidebars?.left ? ' always-show-left' : ''}${dash.sidebars?.right ? ' always-show-right' : ''}`;
  const qc = useQueryClient();
  const { isShare } = useShare();
  const { update } = useEntryMutations();
  const [showAdd,         setShowAdd]         = useState(false);
  const [detailEntry,     setDetailEntry]     = useState(null);
  const [editingProgress, setEditingProgress] = useState(null); // { id, value }
  const [editingRating,   setEditingRating]   = useState(null); // { id, value }
  // Mobile drawer state — '', 'left', or 'right'.
  const [drawer,          setDrawer]          = useState('');
  const [barsReady,       setBarsReady]       = useState(false);
  const barsRef = useRef(null);
  // Adaptive Current/Planned split (% width of Current). null = not measured yet
  // or manual mode; the render falls back to the saved split in that case.
  const [adaptiveSplit,   setAdaptiveSplit]   = useState(null);
  const pairRef = useRef(null);

  const bootstrapQuery = useDashboardBootstrap();
  const dashboardData = bootstrapQuery.data;
  const stats   = dashboardData?.stats ?? null;
  const current = dashboardData?.current?.items ?? [];
  const planned = dashboardData?.planned?.items ?? [];
  const recent  = dashboardData?.completed?.items ?? [];
  const loading = bootstrapQuery.isLoading;
  const error = bootstrapQuery.error?.message || '';

  const activity = useMemo(() => {
    const completedItems = dashboardData?.completed?.items ?? [];
    const currentItems   = dashboardData?.current?.items ?? [];
    const onHoldItems    = dashboardData?.on_hold?.items ?? [];
    const droppedItems   = dashboardData?.dropped?.items ?? [];
    const plannedItems   = dashboardData?.planned?.items ?? [];
    return [
      ...completedItems.slice(0, 6).map(e => ({ type: 'completed', entry: e, time: e.updated_at || e.completed_at })),
      ...currentItems.slice(0, 4).map(e  => ({ type: 'current',   entry: e, time: e.created_at })),
      ...onHoldItems.map(e               => ({ type: 'on_hold',   entry: e, time: e.updated_at })),
      ...droppedItems.map(e              => ({ type: 'dropped',   entry: e, time: e.updated_at })),
      ...plannedItems.map(e              => ({ type: 'planned',   entry: e, time: e.updated_at })),
    ]
      .filter(a => a.time)
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 8);
  }, [dashboardData]);

  const reload = useCallback(() => invalidateEntryData(qc), [qc]);

  // Hovering a sidebar filter warms the Library query (+ its covers) that clicking
  // it will land on, so the jump to Library with the filter applied is instant.
  const prefetchLibraryFilter = useCallback((filter) => {
    const params = { ...defaultLibraryParams(prefs) };
    for (const [k, v] of Object.entries(filter)) if (v) params[k] = v;
    prefetchEntriesWithCovers(qc, params, 'thumb');
  }, [qc, prefs]);

  // Pick up entries added elsewhere (e.g. the extension) when the tab refocuses.
  useRevalidateOnFocus(() => revalidateLibraryRevision(qc));

  const monthBarsData = stats?.entries_per_month ?? [];
  useEffect(() => {
    if (monthBarsData.length > 0) {
      setBarsReady(false);
      barsRef.current = requestAnimationFrame(() => setBarsReady(true));
      return () => cancelAnimationFrame(barsRef.current);
    }
  }, [monthBarsData.length]);

  async function handleStatusChange(id, newStatus) {
    try { await update.mutateAsync({ id, patch: { status: newStatus } }); }
    catch (e) { alert('Failed to update: ' + e.message); }
  }

  async function handleProgressSave(id, value) {
    setEditingProgress(null);
    const num = parseInt(value, 10);
    if (isNaN(num)) return;
    try { await update.mutateAsync({ id, patch: { progress: num } }); }
    catch (e) { alert('Update failed: ' + e.message); }
  }

  async function handleRatingSave(id, value) {
    setEditingRating(null);
    const num = value !== '' ? parseFloat(value) : null;
    if (num !== null && (isNaN(num) || num < 0 || num > 10)) return;
    try { await update.mutateAsync({ id, patch: { rating: num ?? undefined } }); }
    catch (e) { alert('Update failed: ' + e.message); }
  }

  const handleUpdated = (updated) => { syncUpdatedEntry(qc, updated); };

  const handleDeleted = (id) => { setDetailEntry(null); syncDeletedEntry(qc, id); };

  const s       = stats || {};
  const maxBar  = monthBarsData.length ? Math.max(...monthBarsData.map(m => m.count), 1) : 1;
  const manualSplit = dash.manual_split ?? DEFAULT_UI.dashboard.manual_split;
  const baseSplit   = dash.split ?? DEFAULT_UI.dashboard.split ?? 60;
  // Default: use the measured adaptive split. Manual mode (or before the first
  // measurement) falls back to the saved slider value.
  const split   = Math.min(85, Math.max(15,
    (!manualSplit && adaptiveSplit != null) ? adaptiveSplit : baseSplit));

  // ── Shared table rendering: every dashboard table supports the same column
  // catalogue; visibility is driven by the saved per-table column preference. ──
  // Columns in the saved order (filtered to known keys); ordering is set in Settings.
  const dashCols = table => (dash.columns?.[table] || DEFAULT_UI.dashboard.columns[table]).filter(c => DASH_COL_META[c]);
  const dashFixed = table => dash.fixed_tables?.[table] ?? DEFAULT_UI.dashboard.fixed_tables[table];
  const dashTableClass = table => `media-table dash-table-${table}${dashFixed(table) ? ' dash-fixed-title' : ''}`;

  // Measure the two top tables and hand the leftover container slack out evenly,
  // so the whitespace after each table's longest title comes out about equal.
  const measureSplit = useCallback(() => {
    const pair = pairRef.current;
    if (!pair) return;
    const tables = pair.querySelectorAll('table.media-table');
    if (tables.length < 2) { setAdaptiveSplit(null); return; }   // an empty table — no pairing
    const needCur  = tableNeed(tables[0]);
    const needPlan = tableNeed(tables[1]);
    if (needCur == null || needPlan == null) { setAdaptiveSplit(null); return; }
    const gapBetween = parseFloat(getComputedStyle(pair).columnGap) || 0;
    const available = pair.clientWidth - gapBetween;
    if (available <= 0) return;
    const slack = available - needCur - needPlan;
    const curWidth = needCur + slack / 2;                         // equal slack on both sides
    const pct = Math.round((curWidth / available) * 100);
    setAdaptiveSplit(Math.min(80, Math.max(20, pct)));
  }, []);

  // Re-measure on data/column/size changes; a ResizeObserver covers window and
  // sidebar resizes. Skipped entirely in manual mode (the saved split wins).
  const colSig = JSON.stringify([dashCols('current'), dashCols('planned')]);
  useLayoutEffect(() => {
    if (manualSplit || loading) { setAdaptiveSplit(null); return undefined; }
    measureSplit();
    const pair = pairRef.current;
    if (!pair || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measureSplit());
    ro.observe(pair);
    return () => ro.disconnect();
  }, [manualSplit, loading, current, planned, colSig, measureSplit]);

  // Canvas text metrics depend on the web font; re-measure once it has loaded.
  useEffect(() => {
    if (manualSplit || loading || !document.fonts?.ready) return;
    document.fonts.ready.then(() => measureSplit());
  }, [manualSplit, loading, measureSplit]);

  function renderHead(table) {
    return (
      <tr>
        <th>Title</th>
        {dashCols(table).map(c => <th key={c} className={DASH_COL_META[c].cls}>{DASH_COL_META[c].label}</th>)}
      </tr>
    );
  }

  function renderCell(e, col, statusMode) {
    const pct = progressPercent(e);
    switch (col) {
      case 'medium':
        return <td key={col} className="col-medium"><span className="col-dim">{statusMode === 'badge' ? [e.medium, e.origin].filter(Boolean).join(' / ') : (e.medium ?? '—')}</span></td>;
      case 'year':
        return <td key={col} className="col-year"><span className="col-dim">{e.year ?? '—'}</span></td>;
      case 'updated':
        return <td key={col} className="col-updated"><span className="col-dim">{fmtDate(e.updated_at)}</span></td>;
      case 'completed':
        return <td key={col} className="col-completed"><span className="col-dim">{fmtDate(e.completed_at || e.updated_at)}</span></td>;
      case 'progress': {
        const isEditingProg = editingProgress?.id === e.id;
        return (
          <td key={col} className="col-progress" onClick={ev => ev.stopPropagation()}>
            {isEditingProg ? (
              <input className="inline-select inline-number-sm" type="number" min="0"
                value={editingProgress.value} autoFocus
                onChange={ev => setEditingProgress({ id: e.id, value: ev.target.value })}
                onKeyDown={ev => { if (ev.key === 'Enter') handleProgressSave(e.id, editingProgress.value); if (ev.key === 'Escape') setEditingProgress(null); }}
                onBlur={() => handleProgressSave(e.id, editingProgress.value)} />
            ) : (
              <div className={`progress-cell${isShare ? '' : ' is-editable'}`}
                title={isShare ? undefined : 'Click to edit progress'}
                onClick={isShare ? undefined : () => setEditingProgress({ id: e.id, value: String(e.progress ?? '') })}>
                {progressLabel(e)}
                {pct > 0 && <div className="progress-mini"><div className="progress-mini-fill" style={{ '--progress-pct': `${pct}%` }} /></div>}
              </div>
            )}
          </td>
        );
      }
      case 'rating': {
        const isEditingRating = editingRating?.id === e.id;
        return (
          <td key={col} className="col-rating" onClick={ev => ev.stopPropagation()}>
            {isEditingRating ? (
              <input className="inline-select inline-number-sm" type="number" min="0" max="10" step="0.5"
                value={editingRating.value} autoFocus
                onChange={ev => setEditingRating({ id: e.id, value: ev.target.value })}
                onKeyDown={ev => { if (ev.key === 'Enter') handleRatingSave(e.id, editingRating.value); if (ev.key === 'Escape') setEditingRating(null); }}
                onBlur={() => handleRatingSave(e.id, editingRating.value)} />
            ) : (
              <span className={`rating-cell${isShare ? '' : ' is-editable'}`}
                title={isShare ? undefined : 'Click to edit rating'}
                onClick={isShare ? undefined : () => setEditingRating({ id: e.id, value: String(e.rating ?? '') })}>
                {e.rating != null ? e.rating : '—'}<span>/10</span>
              </span>
            )}
          </td>
        );
      }
      case 'status':
        if (statusMode === 'badge' || isShare) {
          return <td key={col} className="col-status"><span className={badgeClass(e.status)}>{statusLabel(e.status)}</span></td>;
        }
        return (
          <td key={col} className="col-status" onClick={ev => ev.stopPropagation()}>
            <CustomSelect className="inline-select" value={e.status}
              options={STATUSES.map(status => ({ value: status, label: statusLabel(status) }))}
              onChange={value => handleStatusChange(e.id, value)}
              containerClassName="table-status-select"
              fitToOptions
              ariaLabel={`Status for ${e.title}`} />
          </td>
        );
      default:
        return null;
    }
  }

  function renderRow(e, table, statusMode) {
    return (
      <tr key={e.id} className="library-row-clickable"
        onMouseEnter={() => prefetchFullCover(e.cover_url, e.cover_key)}
        onClick={() => setDetailEntry(e)}>
        <td>
          <div className="cover-cell">
            <CoverThumb url={coverImgUrl(e.cover_url, 'thumb', e.cover_key)} title={e.title} sourceUrl={e.cover_url} />
            <span className="media-name">{e.title}</span>
          </div>
        </td>
        {dashCols(table).map(c => renderCell(e, c, statusMode))}
      </tr>
    );
  }

  return (
    <div className={`layout-3col dashboard-layout${sidebarClass}`} data-drawer={drawer}>
      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer('')} aria-hidden="true" />
      )}
      <div className="sidebar-hover-zone sidebar-hover-zone-left" aria-hidden="true">
        <span>filters</span>
      </div>
      {/* ── Left sidebar ── */}
      <div className="sidebar-left">
        <div className="sidebar-section">
          <span className="sidebar-label">Status</span>
          {[
            ['',          'All Entries', s.total],
            ['current',   'Current',     s.current],
            ['planned',   'Planned',     s.planned],
            ['completed', 'Completed',   s.completed],
            ['on_hold',   'On Hold',     s.on_hold],
            ['dropped',   'Dropped',     s.dropped],
          ].map(([key, label, count]) => (
            <div key={key} className="sidebar-item"
              onMouseEnter={() => prefetchLibraryFilter({ status: key })}
              onClick={() => onFilterChange({ status: key })}>
              {label}
              {loading
                ? <SkeletonLine width={24} height={14} />
                : count != null && <span className="sidebar-count">{count}</span>}
            </div>
          ))}
        </div>

        <div className="sidebar-divider" />

        <div className="sidebar-section">
          <span className="sidebar-label">Medium</span>
          {loading
            ? <SkeletonSidebarRows rows={6} />
            : (s.by_medium ?? []).map(({ medium, count }) => (
                <div key={medium} className="sidebar-item"
                  onMouseEnter={() => prefetchLibraryFilter({ medium })}
                  onClick={() => onFilterChange({ medium })}>
                  {medium} <span className="sidebar-count">{count}</span>
                </div>
              ))}
        </div>

        <div className="sidebar-divider" />

        <div className="sidebar-section">
          <span className="sidebar-label">Origin</span>
          {loading
            ? <SkeletonSidebarRows rows={5} />
            : (s.by_origin ?? [])
                .filter(({ origin }) => ORIGINS.includes(origin))
                .map(({ origin, count }) => (
                  <div key={origin} className="sidebar-item"
                    onMouseEnter={() => prefetchLibraryFilter({ origin })}
                    onClick={() => onFilterChange({ origin })}>
                    {origin} <span className="sidebar-count">{count}</span>
                  </div>
                ))}
        </div>
      </div>

      {/* ── Main ── */}
      <div className="main-content">
        <div className="page-head">
          <div className="page-head-left">
            <button
              type="button"
              className="drawer-toggle"
              onClick={() => setDrawer(d => d === 'left' ? '' : 'left')}
              aria-label="Toggle filters"
              title="Filters"
            >☰ Filters</button>
            <span className="page-title">Dashboard</span>
            <span className="page-desc">personal media log</span>
          </div>
          <div className="page-head-mobile">
            <button
              type="button"
              className="drawer-toggle"
              onClick={() => setDrawer(d => d === 'right' ? '' : 'right')}
              aria-label="Toggle summary"
              title="Summary"
            >⋯</button>
            {!isShare && <button className="btn" onClick={() => setShowAdd(true)}>+ Add Entry</button>}
          </div>
        </div>

        {error && (
          <div className="state-block">
            <div className="state-title">Connection Error</div>
            <div className="state-detail">{error}</div>
            <button className="btn btn-outline state-retry-btn" onClick={() => reload()}>Retry</button>
          </div>
        )}

        {!error && loading && (
          <div className="skeleton-page" aria-label="Loading dashboard">
            <div
              className="dash-pair-skeleton"
              style={{ '--dash-current-fr': `${split}fr`, '--dash-planned-fr': `${100 - split}fr` }}>
              <div>
                <div className="section-header">Current</div>
                <SkeletonTable
                  headers={['Title', 'Type', 'Progress', 'Status', 'Rating']}
                  rows={8}
                  cover
                  widths={['78%', '58%', '72%', '66%', '46%']}
                />
              </div>
              <div>
                <div className="section-header">Planned</div>
                <SkeletonTable
                  headers={['Title', 'Type', 'Status']}
                  rows={8}
                  cover
                  widths={['74%', '54%', '66%']}
                />
              </div>
            </div>

            <div>
              <div className="section-header">Recently Completed</div>
              <SkeletonTable
                headers={['Title', 'Type', 'Progress', 'Completed', 'Status', 'Rating']}
                rows={7}
                cover
                widths={['76%', '60%', '68%', '58%', '62%', '42%']}
              />
            </div>
          </div>
        )}

        {!error && !loading && (
          <>
          {/* Side-by-side layout for the two tables */}
            <div
              ref={pairRef}
              className="dash-pair"
              style={{ '--dash-current-fr': `${split}fr`, '--dash-planned-fr': `${100 - split}fr` }}>

            {/* Current */}
            <div className="table-size-scope">
                <div className="section-header">Current</div>
                {current.length === 0
                ? <div className="dash-empty">No active entries.</div>
                : (
                    <table className={dashTableClass('current')} data-mobile-show="progress"
                      style={tableGapVars(dashCols('current'))}>
                    <thead>{renderHead('current')}</thead>
                    <tbody>
                        {current.slice(0, dash.current_rows).map(e => renderRow(e, 'current', 'select'))}
                    </tbody>
                    </table>
                )
                }
            </div>

            {/* Planned */}
            <div className="table-size-scope">
                <div className="section-header">Planned</div>
                {planned.length === 0
                ? <div className="dash-empty">No planned entries.</div>
                : (
                    <table className={dashTableClass('planned')} data-mobile-show="medium status"
                      style={tableGapVars(dashCols('planned'))}>
                    <thead>{renderHead('planned')}</thead>
                    <tbody>
                        {planned.slice(0, dash.planned_rows).map(e => renderRow(e, 'planned', 'select'))}
                    </tbody>
                    </table>
                )
                }
            </div>

            </div>

            <div className="table-size-scope">
      <div className="section-header">Recently Completed</div>
      {recent.length === 0
      ? <div className="dash-empty dash-empty-flush">No completed entries yet.</div>
      : (
        <table className={dashTableClass('completed')} data-mobile-show="completed"
                style={tableGapVars(dashCols('completed'))}>
                <thead>{renderHead('completed')}</thead>
                <tbody>
                    {recent.slice(0, dash.completed_rows).map(e => renderRow(e, 'completed', 'badge'))}
                </tbody>
                </table>
            )
            }
            </div>

        </>
        )}
      </div>

      {/* ── Right sidebar ── */}
      <div className="sidebar-hover-zone sidebar-hover-zone-right" aria-hidden="true">
        <span>summary</span>
      </div>
      <div className="sidebar-right">
        <ExtensionUpdateLink />
        <p className="panel-title">Summary</p>
        {loading ? (
          <SkeletonStatGrid />
        ) : (
          <div className="stat-grid">
            <div className="stat-box">
              <span className="stat-val">{s.total ?? '—'}</span>
              <span className="stat-lbl">Total</span>
            </div>
            <div className="stat-box">
              <span className="stat-val">{s.avg_rating ? s.avg_rating.toFixed(1) : '—'}</span>
              <span className="stat-lbl">Avg Rating</span>
            </div>
            <div className="stat-box">
              <span className="stat-val">{s.current ?? current.length}</span>
              <span className="stat-lbl">Active</span>
            </div>
            <div className="stat-box">
              <span className="stat-val">{s.planned ?? '—'}</span>
              <span className="stat-lbl">Planned</span>
            </div>
          </div>
        )}

        {loading && (
          <>
            <p className="panel-title">Consumed / Month</p>
            <div className="chart-area skeleton-mini-chart" aria-hidden="true">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="bar-col">
                  <SkeletonLine width="100%" height={`${18 + (i % 4) * 8}px`} />
                  <SkeletonLine width="80%" height={8} />
                </div>
              ))}
            </div>
          </>
        )}

        {!loading && monthBarsData.length > 0 && (
          <>
            <p className="panel-title">Consumed / Month</p>
            <div className="chart-area">
              {monthBarsData.slice(-7).map((m, i) => (
                <div key={i} className="bar-col">
                  <div className="bar-fill"
                    style={{ '--bar-height': barsReady ? `${Math.round((m.count / maxBar) * 100)}%` : '0%' }} />
                  <span className="bar-label">{m.month ?? m.label ?? ''}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="panel-title dashboard-activity-title">Activity Log</p>
        {loading
          ? <SkeletonActivity rows={8} />
          : activity.length === 0
          ? <div className="dash-empty-log">No recent activity.</div>
          : activity.map((a, i) => (
              <div key={i} className="log-entry">
                <div className={logDotClass(a.type)} />
                <div>
                  <div className="log-text">
                    {a.type === 'completed' ? 'Completed ' :
                     a.type === 'current'   ? 'Started ' :
                     a.type === 'on_hold'   ? 'Put on hold ' :
                     a.type === 'dropped'   ? 'Dropped ' :
                     a.type === 'planned'   ? 'Planned ' : ''}
                    <strong>{a.entry.title}</strong>
                  </div>
                  <span className="log-time">{timeAgo(a.time)}</span>
                </div>
              </div>
            ))
        }
      </div>

      {showAdd && (
        <AddEntryModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { reload(); setShowAdd(false); }}
        />
      )}

      {detailEntry && (
        <EntryDetailModal
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
