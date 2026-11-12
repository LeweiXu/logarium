import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import {
  changePassword, deleteAllEntries, getSettings, updateSettings,
  getBackupStatus, runBackup, getCustomLists, exportEntries,
} from '../api.jsx';
import { MEDIUMS, STATUSES, statusLabel } from '../utils.jsx';
import { usePreferences, DEFAULT_UI } from '../preferences.jsx';
import { useExtensionPresent, useExtensionStatus } from '../extensionBridge.js';
import CustomSelect from './components/CustomSelect.jsx';
import {
  DEFAULT_SOURCES_BY_MEDIUM,
  SEARCH_SOURCES,
  SOURCE_MEDIUMS,
  loadAvailableSources,
  saveAvailableSources,
} from './components/searchSources.js';
import ListsPanel from './components/ListsPanel.jsx';
import DedupPanel from './components/DedupPanel.jsx';
import CacheCoversPanel from './components/CacheCoversPanel.jsx';
import ResyncPanel from './components/ResyncPanel.jsx';
import ImportPanel from './components/ImportPanel.jsx';
import ImportAutoPanel from './components/ImportAutoPanel.jsx';
import ImportMalPanel from './components/ImportMalPanel.jsx';
import RatingDefinitionsPanel from './components/RatingDefinitionsPanel.jsx';
import SharePanel from './components/SharePanel.jsx';
import { useShare } from '../share.jsx';
import ExtensionDownloadSection from './components/ExtensionDownloadSection.jsx';
import QuickAddModal from './components/QuickAddModal.jsx';

const LIBRARY_SORT_FIELDS = [
  { key: 'title', label: 'Title' }, { key: 'medium', label: 'Medium' },
  { key: 'rating', label: 'Rating' }, { key: 'status', label: 'Status' },
  { key: 'year', label: 'Year' }, { key: 'updated_at', label: 'Updated' },
  { key: 'completed_at', label: 'Completed' },
];
const LIBRARY_PAGE_SIZE_OPTIONS = [20, 40, 60, 80, 100];
// Full library column catalogue (key → display label). The user assigns each to
// the Standard or Extra group and orders them by dragging; this list is only the
// label lookup + fallback order for any column not yet placed in either group.
const LIBRARY_COLS = [
  ['medium', 'Medium'], ['status', 'Status'], ['rating', 'Rating'], ['completed', 'Completed'],
  ['year', 'Year'], ['progress', 'Progress'], ['custom_list', 'Custom List'], ['updated', 'Updated'],
];
// Every dashboard table can pick from the same full catalogue (order mirrors
// DASH_COL_ORDER in Dashboard.jsx).
const DASH_COLS = [
  ['medium', 'Type'], ['year', 'Year'], ['progress', 'Progress'],
  ['completed', 'Completed'], ['updated', 'Updated'], ['status', 'Status'], ['rating', 'Rating'],
];
const STAT_SECTIONS = [
  ['summary', 'Summary cards'], ['consumed', 'Consumed / Month'], ['added', 'Added / Month'],
  ['by_medium', 'By Medium'], ['completion', 'Completion by Medium'], ['backlog', 'Backlog Health'],
  ['rating_distribution', 'Rating Distribution'], ['rating_comparison', 'Rating Comparison'],
  ['by_status', 'By Status'], ['by_origin', 'By Origin'], ['release_years', 'Release Year Profile'],
];
const ROW_OPTIONS = [5, 10, 15, 20, 30];
const CONSUMED_RANGE_OPTIONS = [3, 6, 12, 18, 24];
const ADDED_RANGE_OPTIONS = [3, 5, 12, 18];

// Accent presets — value drives the [data-accent] attribute on <html>; swatch
// is the dark-theme ink so the picker reads consistently regardless of theme.
const ACCENT_OPTIONS = [
  { value: 'blue',   label: 'Blue',   swatch: '#4a9eff' },
  { value: 'green',  label: 'Green',  swatch: '#3ecf6a' },
  { value: 'amber',  label: 'Amber',  swatch: '#f5a623' },
  { value: 'cyan',   label: 'Cyan',   swatch: '#38bdf8' },
  { value: 'purple', label: 'Purple', swatch: '#a78bfa' },
  { value: 'red',    label: 'Red',    swatch: '#e05656' },
];

function AccentSwatches({ value, onChange }) {
  return (
    <div className="accent-swatches">
      {ACCENT_OPTIONS.map(({ value: v, label, swatch }) => (
        <button
          key={v}
          type="button"
          className={`accent-swatch${v === value ? ' is-on' : ''}`}
          onClick={() => onChange(v)}
          title={label}
          aria-label={label}
          aria-pressed={v === value}
        >
          <span className="accent-swatch-dot" style={{ '--swatch': swatch }} />
          <span className="accent-swatch-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

function ChipToggle({ on, label, onClick, title }) {
  return (
    <button type="button" className={`source-chip${on ? ' is-on' : ''}`} onClick={onClick} title={title}>
      <span className="source-box">{on ? '[x]' : '[ ]'}</span>
      {label}
    </button>
  );
}

// Drag-to-reorder column picker. Every column — selected or not — is a single
// draggable chip in one row; the chip's [x]/[ ] shows whether it's enabled.
// Dragging reorders; clicking toggles. Only the enabled columns (in their
// dragged order) are persisted via `onChange` — that array drives the table.
// Unselected columns keep their position locally so you can place one before
// enabling it; an external change (e.g. Reset to Defaults) re-syncs the row.
function ColumnOrderEditor({ cols, selected, onChange }) {
  const labelOf = Object.fromEntries(cols);
  const allKeys = cols.map(([key]) => key);
  const validSel = selected.filter(key => labelOf[key] !== undefined);
  const enabledSet = new Set(validSel);

  const [order, setOrder] = useState(() => [...validSel, ...allKeys.filter(k => !enabledSet.has(k))]);
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);

  // Keep the local row in sync with the saved selection. A change we made
  // ourselves leaves the enabled subset of `order` already equal to `selected`,
  // so we keep `order` (preserving unselected positions); anything else (reset)
  // rebuilds the row from the saved order followed by the remaining columns.
  useEffect(() => {
    setOrder(prev => {
      const merged = prev.filter(k => labelOf[k] !== undefined);
      for (const k of allKeys) if (!merged.includes(k)) merged.push(k);
      const enabledInPrev = merged.filter(k => enabledSet.has(k));
      const same = enabledInPrev.length === validSel.length
        && enabledInPrev.every((k, i) => k === validSel[i]);
      return same ? merged : [...validSel, ...allKeys.filter(k => !enabledSet.has(k))];
    });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(key) {
    const next = new Set(enabledSet);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange(order.filter(k => next.has(k)));
  }
  function drop(targetKey) {
    if (dragKey && dragKey !== targetKey) {
      const movingDown = order.indexOf(dragKey) < order.indexOf(targetKey);
      const next = order.filter(k => k !== dragKey);
      let idx = next.indexOf(targetKey);
      if (idx < 0) idx = next.length;
      else if (movingDown) idx += 1;   // dropping past the target → after it (reaches last)
      next.splice(idx, 0, dragKey);
      setOrder(next);
      onChange(next.filter(k => enabledSet.has(k)));
    }
    setDragKey(null); setOverKey(null);
  }

  return (
    <div className="settings-chip-row">
      {order.map(key => {
        const on = enabledSet.has(key);
        // Dragging onto a chip that sits after the dragged one inserts *after*
        // it (indicator on the right); a chip before it inserts before (left).
        const isOver = overKey === key;
        const dropAfter = isOver && dragKey && order.indexOf(dragKey) < order.indexOf(key);
        return (
          <button
            key={key}
            type="button"
            draggable
            className={`source-chip col-chip${on ? ' is-on' : ''}${dragKey === key ? ' is-dragging' : ''}${isOver && !dropAfter ? ' is-over' : ''}${dropAfter ? ' is-over-after' : ''}`}
            onDragStart={e => { setDragKey(key); e.dataTransfer.effectAllowed = 'move'; }}
            onDragEnter={e => { e.preventDefault(); if (dragKey) setOverKey(key); }}
            onDragOver={e => e.preventDefault()}
            onDragEnd={() => { setDragKey(null); setOverKey(null); }}
            onDrop={e => { e.preventDefault(); drop(key); }}
            onClick={() => toggle(key)}
            title="Drag to reorder · click to toggle"
          >
            <span className="col-chip-grip" aria-hidden="true">⠿</span>
            <span className="source-box">{on ? '[x]' : '[ ]'}</span>
            {labelOf[key]}
          </button>
        );
      })}
    </div>
  );
}

// Two-zone drag editor for the library columns. Every catalogue column is a
// chip living in one of two rows — Standard or Extra — with an [x]/[ ] toggle
// for whether it's shown. Drag a chip within a row to reorder, or across to
// reassign its group; drop on the row's empty space to append. Fully controlled:
// each change calls onChange({ standard, additional, shown }) with the full
// group lists (order preserved even for hidden columns) plus the shown set.
function TwoZoneColumnEditor({ cols, standard, additional, shown, onChange }) {
  const labelOf = Object.fromEntries(cols);
  const catalogKeys = cols.map(([key]) => key);
  const valid = key => labelOf[key] !== undefined;

  // Derive the two rows from props. Standard wins if a key somehow lands in both;
  // any catalogue column not placed anywhere falls into Extra so it's reachable.
  const std = standard.filter(valid);
  const stdSet = new Set(std);
  const placed = new Set([...std, ...additional.filter(valid)]);
  const extra = [
    ...additional.filter(key => valid(key) && !stdSet.has(key)),
    ...catalogKeys.filter(key => !placed.has(key)),
  ];
  const shownSet = new Set(shown.filter(valid));

  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);

  function commit(nextStd, nextExtra, nextShown) {
    const shownArr = [...nextStd, ...nextExtra].filter(key => nextShown.has(key));
    onChange({ standard: nextStd, additional: nextExtra, shown: shownArr });
  }

  function toggle(key) {
    const next = new Set(shownSet);
    next.has(key) ? next.delete(key) : next.add(key);
    commit(std, extra, next);
  }

  function move(targetZone, targetKey) {
    if (!dragKey || dragKey === targetKey) { setDragKey(null); setOverKey(null); return; }
    const s = std.filter(key => key !== dragKey);
    const e = extra.filter(key => key !== dragKey);
    const arr = targetZone === 'standard' ? s : e;
    let idx;
    if (targetKey == null) {
      idx = arr.length;
    } else {
      const origArr = targetZone === 'standard' ? std : extra;
      const movingDown = origArr.indexOf(dragKey) !== -1 && origArr.indexOf(dragKey) < origArr.indexOf(targetKey);
      idx = arr.indexOf(targetKey);
      if (idx < 0) idx = arr.length;
      else if (movingDown) idx += 1;
    }
    arr.splice(idx, 0, dragKey);
    commit(targetZone === 'standard' ? arr : s, targetZone === 'standard' ? e : arr, shownSet);
    setDragKey(null); setOverKey(null);
  }

  const chip = (key, zone) => {
    const on = shownSet.has(key);
    const isOver = overKey === key;
    const origArr = zone === 'standard' ? std : extra;
    const dropAfter = isOver && dragKey && origArr.indexOf(dragKey) !== -1 && origArr.indexOf(dragKey) < origArr.indexOf(key);
    return (
      <button key={key} type="button" draggable
        className={`source-chip col-chip${on ? ' is-on' : ''}${dragKey === key ? ' is-dragging' : ''}${isOver && !dropAfter ? ' is-over' : ''}${dropAfter ? ' is-over-after' : ''}`}
        onDragStart={e => { setDragKey(key); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnter={e => { e.preventDefault(); if (dragKey) setOverKey(key); }}
        onDragOver={e => e.preventDefault()}
        onDragEnd={() => { setDragKey(null); setOverKey(null); }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); move(zone, key); }}
        onClick={() => toggle(key)}
        title="Drag to reorder or move between rows · click to show/hide">
        <span className="col-chip-grip" aria-hidden="true">⠿</span>
        <span className="source-box">{on ? '[x]' : '[ ]'}</span>
        {labelOf[key]}
      </button>
    );
  };

  const zone = (label, zoneKey, keys) => (
    <div className="col-zone">
      <span className="col-zone-label">{label}</span>
      <div className="settings-chip-row col-zone-row"
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); move(zoneKey, null); }}>
        {keys.length === 0
          ? <span className="col-zone-empty">Drag columns here</span>
          : keys.map(key => chip(key, zoneKey))}
      </div>
    </div>
  );

  return (
    <div className="col-zones">
      {zone('Standard', 'standard', std)}
      {zone('Extra', 'extra', extra)}
    </div>
  );
}

// ── Full-width terminal layout primitives ──
// Viewing someone's shared profile shows this page exactly as they see it, but
// inert: every Section/ToolCard below reads this and greys itself out. A card
// opts back in with `unlocked` (only Rating Definitions does).
const LockContext = createContext(false);

function useLocked(unlocked) {
  return useContext(LockContext) && !unlocked;
}

// A bordered section with a header rule; body spans the full panel width.
function Section({ title, desc, danger, unlocked, children }) {
  const locked = useLocked(unlocked);
  return (
    <section className={`settings-section${danger ? ' is-danger' : ''}${locked ? ' is-locked' : ''}`}
      aria-disabled={locked || undefined}>
      <div className="settings-section-head">
        <span className="sh-title">{title}</span>
        {desc && <span className="sh-desc">{desc}</span>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

// A collapsible tool card (Tools tab). Collapsed by default; the body only mounts
// once expanded, so a panel's on-mount work (DedupPanel's duplicate scan, ListsPanel's
// library load, an import/cache SSE stream) runs only when the user opens the card,
// and aborts when they collapse it. Reuses the section header's toggle styling.
function ToolCard({ title, desc, children, defaultOpen = false, unlocked }) {
  const [open, setOpen] = useState(defaultOpen);
  const locked = useLocked(unlocked);
  return (
    <section className={`settings-section${locked ? ' is-locked' : ''}`}
      aria-disabled={locked || undefined}>
      <button type="button" className="settings-section-head settings-section-toggle"
        aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="sh-title">{title}</span>
        {desc && <span className="sh-desc">{desc}</span>}
        <span className="sh-toggle-ind" aria-hidden="true">{open ? '[ - ]' : '[ + ]'}</span>
      </button>
      {open && <div className="settings-section-body">{children}</div>}
    </section>
  );
}

// A single setting line: label/description on the left, control on the right.
// `stack` drops the control onto its own full-width line below the label.
function Row({ title, desc, stack, children }) {
  return (
    <div className={`set-row${stack ? ' set-row-stack' : ''}`}>
      <div className="set-row-label">
        <span className="l-title">{title}</span>
        {desc && <span className="l-desc">{desc}</span>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function Slider({ value, min, max, step = 1, onChange, format, disabled }) {
  return (
    <div className="set-slider">
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={e => onChange(Number(e.target.value))} />
      <span className="set-slider-val">{format ? format(value) : value}</span>
    </div>
  );
}

// A select sized to sit on the right of a setting row.
function RowSelect(props) {
  return <CustomSelect
    {...props}
    containerClassName={`settings-row-select ${props.containerClassName || ''}`.trim()}
  />;
}

export default function Console({ theme, onThemeChange, accent, onAccentChange, onLogout, onDataDeleted }) {
  const { prefs, loaded: prefsLoaded, error: prefsError, reload: reloadPrefs, updateUi } = usePreferences();
  const { isShare } = useShare();
  const [reloading, setReloading] = useState(false);

  // ── Local mirror of the UI document for instant feedback; persisted on change. ──
  // Capture only after a *successful* load — never lock onto the defaults shown
  // during a failed fetch, so a later retry/self-heal seeds the real settings.
  const [ui, setUi] = useState(prefs);
  const uiReadyRef = useRef(false);
  useEffect(() => {
    if (prefsLoaded && !prefsError && !uiReadyRef.current) { setUi(prefs); uiReadyRef.current = true; }
  }, [prefsLoaded, prefsError, prefs]);

  function saveUi(patch) {
    // patch is a partial UI doc; merge into local state and persist.
    setUi(prev => mergeDeep(prev, patch));
    updateUi(patch).catch(() => {});
  }
  function setColumns(section, table, next) {
    saveUi({ [section]: { columns: { [table]: next } } });
  }
  function toggleStatSection(key) {
    const current = ui.statistics?.sections?.[key];
    saveUi({ statistics: { sections: { [key]: !current } } });
  }

  const lib = ui.library || DEFAULT_UI.library;
  const dash = ui.dashboard || DEFAULT_UI.dashboard;
  const statp = ui.statistics || DEFAULT_UI.statistics;
  const exp = ui.explore || DEFAULT_UI.explore;
  const display = ui.display || DEFAULT_UI.display;
  const visibleMediums = ui.mediums?.visible ?? DEFAULT_UI.mediums.visible;
  const visibleMediumSet = new Set(visibleMediums);
  const dashFixed = table => dash.fixed_tables?.[table] ?? DEFAULT_UI.dashboard.fixed_tables[table];
  const dashManualSplit = dash.manual_split ?? DEFAULT_UI.dashboard.manual_split;
  const sidebarOn = (section, side) => ui[section]?.sidebars?.[side] ?? DEFAULT_UI[section].sidebars[side];

  // ── Library tools state ──
  const extPresent = useExtensionPresent();
  // Only surface the extension download section when there's something to do:
  // it's not installed, or an installed copy is out of date.
  const { present: extInstalled, outOfDate: extOutOfDate } = useExtensionStatus();
  const showExtSection = !extInstalled || extOutOfDate;
  const [customLists, setCustomLists] = useState([]);
  const reloadLists = useCallback(async () => {
    try {
      const data = await getCustomLists();
      setCustomLists(Array.isArray(data) ? data : []);
    } catch { /* lists are best-effort */ }
  }, []);
  useEffect(() => { reloadLists(); }, [reloadLists]);

  // ── Sitewide *available* search sources (which sources the Add Entry and
  //    Explore pickers offer). Shared via localStorage; read by those pages. ──
  const [availableSources, setAvailableSources] = useState(() => loadAvailableSources());
  function toggleSource(value) {
    setAvailableSources(prev => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      saveAvailableSources(next);
      return next;
    });
  }

  function toggleVisibleMedium(value) {
    const next = new Set(visibleMediums);
    const enabling = !next.has(value);
    enabling ? next.add(value) : next.delete(value);
    const patch = { mediums: { visible: MEDIUMS.filter(medium => next.has(medium)) } };
    if (exp.default_medium && !next.has(exp.default_medium)) {
      patch.explore = { default_medium: null };
    }
    setAvailableSources(prev => {
      const nextSources = new Set(prev);
      if (enabling) {
        (DEFAULT_SOURCES_BY_MEDIUM[value] || []).forEach(source => nextSources.add(source));
      } else {
        for (const [source, mediums] of Object.entries(SOURCE_MEDIUMS)) {
          if (mediums.includes(value) && mediums.every(medium => !next.has(medium))) {
            nextSources.delete(source);
          }
        }
      }
      saveAvailableSources(nextSources);
      return nextSources;
    });
    saveUi(patch);
  }

  function saveTheme(value) {
    const next = value === 'light' ? 'light' : 'dark';
    onThemeChange?.(next);
    saveUi({ display: { theme: next } });
  }

  function saveAccent(value) {
    const next = value || 'blue';
    onAccentChange?.(next);
    saveUi({ display: { accent: next } });
  }

  const ratedStatuses = dash.rated_statuses ?? DEFAULT_UI.dashboard.rated_statuses;
  function toggleRatedStatus(status) {
    const next = ratedStatuses.includes(status)
      ? ratedStatuses.filter(s => s !== status)
      : STATUSES.filter(s => ratedStatuses.includes(s) || s === status);
    saveUi({ dashboard: { rated_statuses: next } });
  }

  function toggleDashFluid(table) {
    saveUi({ dashboard: { fixed_tables: { [table]: !dashFixed(table) } } });
  }
  function toggleSidebar(section, side) {
    saveUi({ [section]: { sidebars: { [side]: !sidebarOn(section, side) } } });
  }

  async function exportCSV() {
    try {
      const blob = await exportEntries();
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob), download: 'library.csv',
      });
      a.click();
    } catch (err) { alert(`Export failed: ${err.message}`); }
  }

  const settingsFileRef = useRef(null);
  const [settingsImportMsg, setSettingsImportMsg] = useState('');
  const [settingsImportErr, setSettingsImportErr] = useState('');

  async function exportSettingsFile() {
    try {
      const current = await getSettings();
      const payload = {
        type: 'logarium-settings',
        version: 1,
        exported_at: new Date().toISOString(),
        settings: {
          backup_freq: current.backup_freq || 'never',
          ui: current.ui || DEFAULT_UI,
        },
        available_sources: [...loadAvailableSources()],
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), {
        href: url,
        download: 'logarium-settings.json',
      });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setSettingsImportMsg('');
      setSettingsImportErr(`Settings export failed: ${err.message}`);
    }
  }

  async function importSettingsFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSettingsImportMsg('');
    setSettingsImportErr('');
    try {
      const parsed = JSON.parse(await file.text());
      const settingsDoc = parsed.settings && typeof parsed.settings === 'object'
        ? parsed.settings
        : parsed;
      const patch = {};
      if (typeof settingsDoc.backup_freq === 'string') patch.backup_freq = settingsDoc.backup_freq;
      if (settingsDoc.ui && typeof settingsDoc.ui === 'object' && !Array.isArray(settingsDoc.ui)) {
        patch.ui = settingsDoc.ui;
      }

      const importedSources = Array.isArray(parsed.available_sources)
        ? parsed.available_sources
        : Array.isArray(parsed.availableSources)
          ? parsed.availableSources
          : null;
      const hasSettings = Object.keys(patch).length > 0;
      if (!hasSettings && !importedSources) {
        throw new Error('File does not contain Logarium settings.');
      }

      let saved = null;
      if (hasSettings) {
        saved = await updateSettings(patch);
        setBackupFreq(saved.backup_freq || 'never');
        setUi(saved.ui || DEFAULT_UI);
        uiReadyRef.current = true;
        scalarsReadyRef.current = true;
        await reloadPrefs();
      }

      if (importedSources) {
        const validSources = new Set(SEARCH_SOURCES.map(source => source.value));
        const nextSources = new Set(importedSources.filter(source => validSources.has(source)));
        saveAvailableSources(nextSources);
        setAvailableSources(nextSources);
      }
      setSettingsImportMsg('Settings imported.');
    } catch (err) {
      setSettingsImportErr(`Settings import failed: ${err.message}`);
    }
  }

  // ── backup_freq is the only remaining scalar setting (a backend concern). ──
  const [backupFreq,     setBackupFreq]     = useState('never');
  const [scalarsLoaded,  setScalarsLoaded]  = useState(false);
  const scalarsReadyRef = useRef(false);

  const [backupEmail,   setBackupEmail]   = useState('');
  const [lastBackupAt,  setLastBackupAt]  = useState(null);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupError,   setBackupError]   = useState('');
  const [backupNotice,  setBackupNotice]  = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getSettings();
        if (cancelled) return;
        setBackupFreq(s.backup_freq || 'never');
      } catch { /* ignore */ }
      finally { if (!cancelled) setScalarsLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // A shared profile never sees the owner's backup email, so skip the call.
    if (isShare) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const b = await getBackupStatus();
        if (cancelled) return;
        setBackupEmail(b.email || '');
        setLastBackupAt(b.last_backup_at || null);
      } catch { /* degrade gracefully */ }
    })();
    return () => { cancelled = true; };
  }, [isShare]);

  useEffect(() => {
    if (!scalarsLoaded) return;
    if (!scalarsReadyRef.current) { scalarsReadyRef.current = true; return; }
    const id = setTimeout(() => {
      updateSettings({ backup_freq: backupFreq }).catch(() => {});
    }, 400);
    return () => clearTimeout(id);
  }, [backupFreq, scalarsLoaded]);

  // ── Password / logout / delete ──
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [screen, setScreen] = useState('settings');
  // Two-tab split: Tools (library/import/extension tools, uncollapsed) opens by
  // default; Settings holds all preference panels. Switching away from Tools
  // unmounts the tool panels (aborting any running SSE stream), mirroring the
  // old collapse-to-abort behaviour.
  const [tab, setTab] = useState('tools');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    setError(''); setSuccess(false);
    if (newPw !== confirmPw) { setError('New passwords do not match.'); return; }
    setSaving(true);
    try {
      await changePassword(currentPw, newPw);
      setSuccess(true);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function handleRunBackup() {
    setBackupError(''); setBackupNotice(''); setBackupRunning(true);
    try {
      const b = await runBackup();
      setLastBackupAt(b.last_backup_at || null);
      setBackupNotice(`Backup sent to ${b.email}.`);
    } catch (err) { setBackupError(err.message || String(err)); }
    finally { setBackupRunning(false); }
  }

  async function handleResetDefaults() {
    setResetting(true); setResetDone(false);
    try {
      // Overwrite the whole UI doc with defaults (the PUT deep-merges, and
      // DEFAULT_UI covers every key, so this is a full reset). Reset backup
      // cadence and the display theme/accent too.
      await updateSettings({ ui: DEFAULT_UI, backup_freq: 'never' });
      setUi(DEFAULT_UI);
      setBackupFreq('never');
      onThemeChange?.('dark');
      onAccentChange?.('blue');
      await reloadPrefs();
      setConfirmReset(false);
      setResetDone(true);
    } catch (err) { setDeleteError(err.message || String(err)); }
    finally { setResetting(false); }
  }

  async function handleDeleteAll() {
    setDeleting(true); setDeleteError('');
    try {
      await deleteAllEntries();
      onDataDeleted?.();
      setScreen('settings');
    } catch (err) { setDeleteError(err.message); setDeleting(false); }
  }

  if (screen === 'confirm-delete') {
    return (
      <div className="stats-layout">
        <div className="settings-page">
          <div className="page-head console-confirm-head">
            <div className="page-head-left"><span className="page-title">Delete All Data</span></div>
          </div>
          <section className="settings-section is-danger">
            <div className="settings-section-head">
              <span className="sh-title">Confirm deletion</span>
            </div>
            <div className="settings-section-body console-delete-body">
              <p className="console-delete-title">This will permanently delete all your library entries.</p>
              <p className="console-delete-copy">
                This action cannot be undone. Your account will remain active, but every entry in your library will be gone forever.
              </p>
              {deleteError && <div className="settings-msg settings-msg-error">{deleteError}</div>}
              <div className="console-delete-actions">
                <button className="btn" onClick={() => setScreen('settings')} disabled={deleting}>Cancel</button>
                <button className="btn btn-danger" onClick={handleDeleteAll} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Yes, delete everything'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const dashColSel = table => dash.columns?.[table] ?? DEFAULT_UI.dashboard.columns[table];

  return (
    <LockContext.Provider value={isShare}>
    <div className="stats-layout">
      <div className="settings-page">
        <div className="page-head console-page-head">
          <div className="page-head-left">
            <span className="page-title">Console</span>
            <span className="page-desc">library tools & settings</span>
          </div>
        </div>

        {/* ── Tab bar: Tools (default) · Settings — full width, 50/50 ── */}
        <div className="term-tabs console-tabs">
          <button type="button" className={`term-tab${tab === 'tools' ? ' is-on' : ''}`}
            onClick={() => setTab('tools')}>Tools</button>
          <button type="button" className={`term-tab${tab === 'settings' ? ' is-on' : ''}`}
            onClick={() => setTab('settings')}>Settings</button>
        </div>

        {prefsError && tab === 'settings' && (
          <div className="settings-load-error">
            <span>
              Couldn't load your saved settings — the server may be unreachable.
              The values below are defaults; editing now may not reflect your real preferences.
            </span>
            <button type="button" className="btn btn-outline" disabled={reloading}
              onClick={async () => { setReloading(true); await reloadPrefs(); setReloading(false); }}>
              {reloading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}

        {/* ════════════════════════════ TOOLS TAB ════════════════════════════ */}
        {tab === 'tools' && (
        <>
        {/* ── Browser extension (only when not installed or out of date) ── */}
        {!isShare && showExtSection && (
          <>
            <p className="console-group-label">Browser Extension</p>
            <Section title="Logarium Browser Extension"
              desc="add from source pages, cache covers, and unlock blocked sources">
              <ExtensionDownloadSection />
            </Section>
          </>
        )}

        {/* ── Library tools — each a collapsed card; opening one mounts (and runs) it ── */}
        <p className="console-group-label">Library Tools</p>
        <ToolCard title="Rating Definitions" desc="what each score means to this library"
          unlocked defaultOpen={isShare}>
          <div className="console-tool-body"><RatingDefinitionsPanel readOnly={isShare} /></div>
        </ToolCard>
        <ToolCard title="Manage Lists" desc="build, rename or delete custom lists">
          <div className="console-tool-body">
            <ListsPanel initialTab="manage" existingLists={customLists}
              onCreated={reloadLists} onRenamed={reloadLists} onDeleted={reloadLists} />
          </div>
        </ToolCard>
        <ToolCard title="Find Duplicates" desc="merge entries that share a title + medium">
          <div className="console-tool-body"><DedupPanel /></div>
        </ToolCard>
        <ToolCard title="Cache Covers (server)" desc="download & store uncached covers on the server">
          <div className="console-tool-body"><CacheCoversPanel /></div>
        </ToolCard>
        {!isShare && (
          <ToolCard title="Cache Covers (extension)"
            desc="resync covers first-party via the browser extension">
            <div className="console-tool-body">
              {extPresent
                ? <ResyncPanel />
                : <p className="console-tool-note">
                    Requires the Logarium browser extension.
                  </p>}
            </div>
          </ToolCard>
        )}
        <ToolCard title="Quick Add" desc="backfill consumed media from recommendations">
          <div className="console-tool-body">
            <QuickAddModal inline onCreated={reloadLists} />
          </div>
        </ToolCard>
        {!isShare && (
          <ToolCard title="Share Profile" desc="a read-only link to your library">
            <div className="console-tool-body"><SharePanel /></div>
          </ToolCard>
        )}

        {/* ── Import / Export ── */}
        <p className="console-group-label">Import / Export</p>
        <Section title="Import" desc="bring CSVs, a MyAnimeList export, or saved settings into your library">
          <ImportPanel onImported={reloadLists} />
          <ImportAutoPanel onImported={reloadLists} />
          <ImportMalPanel onImported={reloadLists} />
          <Row title="Import settings" desc="Restore a Logarium settings JSON file. Library entries are not changed.">
            <div className="settings-import-actions">
              <input ref={settingsFileRef} type="file" accept=".json,application/json"
                className="hidden-file" onChange={importSettingsFile} />
              <button type="button" className="btn" onClick={() => settingsFileRef.current?.click()}>
                Import Settings
              </button>
              {settingsImportMsg && <span className="settings-msg settings-msg-success">{settingsImportMsg}</span>}
              {settingsImportErr && <span className="settings-msg settings-msg-error">{settingsImportErr}</span>}
            </div>
          </Row>
        </Section>
        <Section title="Export" desc="download library data or Console settings">
          <Row title="Export CSV" desc="A full snapshot of every entry, importable back into Logarium.">
            <button type="button" className="btn" onClick={exportCSV}>Export CSV</button>
          </Row>
          <Row title="Export settings" desc="Download UI preferences, backup frequency, and available source selections.">
            <button type="button" className="btn" onClick={exportSettingsFile}>Export Settings</button>
          </Row>
        </Section>
        </>
        )}

        {/* ═══════════════════════════ SETTINGS TAB ══════════════════════════ */}
        {tab === 'settings' && (
        <>
        {/* ── Display ── */}
        <Section title="Display">
          <Row title="Theme" desc="Colour scheme for the whole interface.">
            <RowSelect
              value={display.theme || theme || 'dark'}
              options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
              onChange={saveTheme}
              ariaLabel="Theme"
            />
          </Row>
          <Row title="Accent colour" desc="Highlight for buttons, selections, progress bars and links." stack>
            <AccentSwatches value={display.accent || accent || 'blue'} onChange={saveAccent} />
          </Row>
        </Section>

        {/* ── Media & Search Sources ── */}
        <Section title="Media & Search Sources">
          <Row
            title="Visible mediums"
            desc="Hidden mediums stay in your library data, but disappear from frontend views and selectors."
            stack>
            <div className="settings-chip-row">
              {MEDIUMS.map(medium => (
                <ChipToggle
                  key={medium}
                  label={medium}
                  on={visibleMediumSet.has(medium)}
                  onClick={() => toggleVisibleMedium(medium)}
                />
              ))}
            </div>
          </Row>
          <Row
            title="Available sources"
            desc="Which providers the Add Entry and Explore source pickers offer."
            stack>
            <div className="settings-chip-row">
              {SEARCH_SOURCES.map(s => (
                <ChipToggle key={s.value} label={s.label}
                  on={availableSources.has(s.value)}
                  onClick={() => toggleSource(s.value)} />
              ))}
            </div>
          </Row>
        </Section>

        {/* ── Dashboard (before Library) ── */}
        <Section title="Dashboard" desc="home page layout">
          <Row title="Current — rows" desc="Maximum rows shown in the active table.">
            <RowSelect value={dash.current_rows}
              options={ROW_OPTIONS.map(n => ({ value: n, label: String(n) }))}
              onChange={v => saveUi({ dashboard: { current_rows: Number(v) } })} ariaLabel="Current rows" />
          </Row>
          <Row title="Planned — rows" desc="Maximum rows shown in the planned table.">
            <RowSelect value={dash.planned_rows}
              options={ROW_OPTIONS.map(n => ({ value: n, label: String(n) }))}
              onChange={v => saveUi({ dashboard: { planned_rows: Number(v) } })} ariaLabel="Planned rows" />
          </Row>
          <Row title="Recently rated — rows" desc="Maximum rows shown in the recently rated table.">
            <RowSelect value={dash.completed_rows}
              options={ROW_OPTIONS.map(n => ({ value: n, label: String(n) }))}
              onChange={v => saveUi({ dashboard: { completed_rows: Number(v) } })} ariaLabel="Recently rated rows" />
          </Row>
          <Row title="Recently rated — statuses" desc="Which statuses the table draws from. Rating something is the signal you consumed it, finished or not." stack>
            <div className="settings-chip-row">
              {STATUSES.map(status => (
                <ChipToggle key={status} label={statusLabel(status)}
                  on={ratedStatuses.includes(status)}
                  onClick={() => toggleRatedStatus(status)} />
              ))}
            </div>
          </Row>
          <Row title="Current / Planned split" desc="Auto-balances the two top tables so whitespace after the longest title is even. Turn on Manual split to set the widths yourself." stack>
            <div className="dash-split-control">
              <div className="settings-chip-row">
                <ChipToggle label="Manual split" on={dashManualSplit}
                  onClick={() => saveUi({ dashboard: { manual_split: !dashManualSplit } })} />
              </div>
              <div className={`set-slider-fade${dashManualSplit ? ' is-active' : ''}`}
                aria-hidden={!dashManualSplit}>
                <Slider value={dash.split ?? DEFAULT_UI.dashboard.split} min={20} max={80} step={5}
                  disabled={!dashManualSplit}
                  onChange={n => saveUi({ dashboard: { split: n } })}
                  format={n => `${n}% / ${100 - n}%`} />
              </div>
            </div>
          </Row>
          <Row title="Fluid tables" desc="Enable fluid sizing per dashboard table." stack>
            <div className="settings-chip-row">
              <ChipToggle label="Current" on={!dashFixed('current')} onClick={() => toggleDashFluid('current')} />
              <ChipToggle label="Planned" on={!dashFixed('planned')} onClick={() => toggleDashFluid('planned')} />
              <ChipToggle label="Recently Rated" on={!dashFixed('completed')} onClick={() => toggleDashFluid('completed')} />
            </div>
          </Row>
          <Row title="Always show sidebars" desc="Override automatic desktop sidebar hiding on the Dashboard page." stack>
            <div className="settings-chip-row">
              <ChipToggle label="Left sidebar" on={sidebarOn('dashboard', 'left')} onClick={() => toggleSidebar('dashboard', 'left')} />
              <ChipToggle label="Right sidebar" on={sidebarOn('dashboard', 'right')} onClick={() => toggleSidebar('dashboard', 'right')} />
            </div>
          </Row>
          <Row title="Current columns" desc="Drag to reorder · click to toggle." stack>
            <ColumnOrderEditor cols={DASH_COLS} selected={dashColSel('current')}
              onChange={next => setColumns('dashboard', 'current', next)} />
          </Row>
          <Row title="Planned columns" stack>
            <ColumnOrderEditor cols={DASH_COLS} selected={dashColSel('planned')}
              onChange={next => setColumns('dashboard', 'planned', next)} />
          </Row>
          <Row title="Recently-completed columns" stack>
            <ColumnOrderEditor cols={DASH_COLS} selected={dashColSel('completed')}
              onChange={next => setColumns('dashboard', 'completed', next)} />
          </Row>
        </Section>

        {/* ── Library ── */}
        <Section title="Library">
          <Row title="Rating granularity" desc="Step size for rating up/down; ratings snap to this on save.">
            <RowSelect value={ui.rating_step ?? DEFAULT_UI.rating_step}
              options={[
                { value: 0.1, label: '0.1' },
                { value: 0.5, label: '0.5 (halves)' },
                { value: 1, label: '1.0 (whole)' },
              ]}
              onChange={v => saveUi({ rating_step: Number(v) })} ariaLabel="Rating granularity" />
          </Row>
          <Row title="Default sort" desc="Sort order applied when you open the library.">
            <RowSelect value={lib.default_sort}
              options={LIBRARY_SORT_FIELDS.map(f => ({ value: f.key, label: f.label }))}
              onChange={v => saveUi({ library: { default_sort: v } })} ariaLabel="Default sort" />
          </Row>
          <Row title="Entries per page">
            <RowSelect value={lib.entries_per_page}
              options={LIBRARY_PAGE_SIZE_OPTIONS.map(s => ({ value: s, label: String(s) }))}
              onChange={v => saveUi({ library: { entries_per_page: Number(v) } })} ariaLabel="Entries per page" />
          </Row>
          <Row title="Default mode" desc="Normal view or Multi-select when the library opens.">
            <RowSelect value={lib.default_mode}
              options={[{ value: 'view', label: 'View' }, { value: 'manage', label: 'Multi-select' }]}
              onChange={v => saveUi({ library: { default_mode: v } })} ariaLabel="Default library mode" />
          </Row>
          <Row title="Table behaviour" stack>
            <div className="settings-chip-row">
              <ChipToggle label="Fluid Table" on={!lib.fix_title} onClick={() => saveUi({ library: { fix_title: !lib.fix_title } })} />
              <ChipToggle label="Quick Actions" on={!!lib.quick_actions} onClick={() => saveUi({ library: { quick_actions: !lib.quick_actions } })} />
            </div>
          </Row>
          <Row title="Always show sidebars" desc="Override automatic desktop sidebar hiding on the Library page." stack>
            <div className="settings-chip-row">
              <ChipToggle label="Left sidebar" on={sidebarOn('library', 'left')} onClick={() => toggleSidebar('library', 'left')} />
              <ChipToggle label="Right sidebar" on={sidebarOn('library', 'right')} onClick={() => toggleSidebar('library', 'right')} />
            </div>
          </Row>
          <Row title="Columns"
            desc="Drag a column into Standard (shown by default) or Extra (opt-in, also toggleable from the library sidebar). Order within each row sets column order; click a chip to show/hide it."
            stack>
            <TwoZoneColumnEditor
              cols={LIBRARY_COLS}
              standard={lib.columns?.standard ?? DEFAULT_UI.library.columns.standard}
              additional={lib.columns?.additional ?? DEFAULT_UI.library.columns.additional}
              shown={lib.columns?.shown ?? DEFAULT_UI.library.columns.shown}
              onChange={next => saveUi({ library: { columns: next } })} />
          </Row>
        </Section>

        {/* ── Statistics ── */}
        <Section title="Statistics">
          <Row title="Consumed range" desc="Default window for the consumed-per-month chart.">
            <RowSelect value={statp.consumed_range}
              options={CONSUMED_RANGE_OPTIONS.map(n => ({ value: n, label: `${n} months` }))}
              onChange={v => saveUi({ statistics: { consumed_range: Number(v) } })} ariaLabel="Consumed range" />
          </Row>
          <Row title="Added range" desc="Default window for the added-per-month chart.">
            <RowSelect value={statp.added_range}
              options={ADDED_RANGE_OPTIONS.map(n => ({ value: n, label: `${n} months` }))}
              onChange={v => saveUi({ statistics: { added_range: Number(v) } })} ariaLabel="Added range" />
          </Row>
          <Row title="Visible cards" desc="Pick exactly which charts appear on the statistics page." stack>
            <div className="settings-chip-row">
              {STAT_SECTIONS.map(([key, label]) => (
                <ChipToggle key={key} label={label} on={statp.sections?.[key] !== false} onClick={() => toggleStatSection(key)} />
              ))}
            </div>
          </Row>
        </Section>

        {/* ── Explore ── */}
        <Section title="Explore">
          <Row title="Default medium">
            <RowSelect value={exp.default_medium || ''}
              options={[{ value: '', label: 'All' }, ...visibleMediums.map(m => ({ value: m, label: m }))]}
              onChange={v => saveUi({ explore: { default_medium: v || null } })}
              maxVisible={visibleMediums.length + 1} ariaLabel="Default medium" />
          </Row>
          <Row title="Recommendations" stack>
            <div className="settings-chip-row">
              <ChipToggle label="Personalize" on={exp.personalize !== false}
                onClick={() => saveUi({ explore: { personalize: !(exp.personalize !== false) } })}
                title="Order recommendations by your consumption profile (genres/origins per medium; most-consumed mediums lead the All view)" />
              <ChipToggle label="Hide owned" on={exp.hide_in_library !== false}
                onClick={() => saveUi({ explore: { hide_in_library: !(exp.hide_in_library !== false) } })}
                title="Hide titles already in your library" />
            </div>
          </Row>
          <Row title="Always show sidebars" desc="Override automatic desktop sidebar hiding on the Explore page." stack>
            <div className="settings-chip-row">
              <ChipToggle label="Left sidebar" on={sidebarOn('explore', 'left')} onClick={() => toggleSidebar('explore', 'left')} />
              <ChipToggle label="Right sidebar" on={sidebarOn('explore', 'right')} onClick={() => toggleSidebar('explore', 'right')} />
            </div>
          </Row>
        </Section>

        {/* ── Authentication ── */}
        <Section title="Authentication">
          <Row title="Change password" desc="Update the password for this account." stack>
            <form onSubmit={handleChangePassword} className="settings-form">
              <div className="form-row">
                <label className="form-label">Current password</label>
                <input className="form-input" type="password" autoComplete="current-password"
                  value={currentPw} onChange={e => setCurrentPw(e.target.value)} required />
              </div>
              <div className="form-row-2">
                <div className="form-row">
                  <label className="form-label">New password</label>
                  <input className="form-input" type="password" autoComplete="new-password"
                    value={newPw} onChange={e => setNewPw(e.target.value)} required minLength={6} />
                </div>
                <div className="form-row">
                  <label className="form-label">Confirm new password</label>
                  <input className="form-input" type="password" autoComplete="new-password"
                    value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required minLength={6} />
                </div>
              </div>
              {error   && <div className="settings-msg settings-msg-error">{error}</div>}
              {success && <div className="settings-msg settings-msg-success">Password changed.</div>}
              <div className="settings-form-actions">
                <button className="btn" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Update Password'}</button>
              </div>
            </form>
          </Row>
          <Row title="Log out" desc="End your current session on this device.">
            {confirmLogout ? (
              <div className="settings-confirm-actions">
                <span className="confirm-inline-text">sure?</span>
                <button type="button" className="btn btn-danger-outline settings-confirm-btn" onClick={() => onLogout?.()}>Yes, log out</button>
                <button type="button" className="icon-btn settings-confirm-btn" onClick={() => setConfirmLogout(false)}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmLogout(true)}>Log out</button>
            )}
          </Row>
        </Section>

        {/* ── Periodic Backup ── */}
        <Section title="Periodic Backup">
          <Row
            title="Backup frequency"
            desc={<>A CSV copy of your library is emailed to <span className="text-normal">{backupEmail || 'your account email'}</span> on this schedule.</>}>
            <div className="set-row-control">
              <RowSelect value={backupFreq}
                options={[
                  { value: 'never', label: 'Never' }, { value: 'daily', label: 'Daily' },
                  { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' },
                ]}
                onChange={setBackupFreq} disabled={!scalarsLoaded} ariaLabel="Backup frequency" />
              <button type="button" className="btn" onClick={handleRunBackup} disabled={backupRunning}>
                {backupRunning ? 'Sending…' : 'Back up now'}
              </button>
            </div>
          </Row>
          <Row title="Last backup" desc={lastBackupAt ? new Date(lastBackupAt).toLocaleString() : 'No backup has been sent yet.'} stack>
            {backupError  && <div className="settings-msg settings-msg-error">{backupError}</div>}
            {backupNotice && <div className="settings-msg settings-msg-success">{backupNotice}</div>}
          </Row>
        </Section>

        {/* ── Danger Zone ── */}
        <Section title="Danger Zone" danger>
          <Row title="Reset settings" desc="Restore all display, layout, and column preferences to their defaults. Your library and password are not affected.">
            {confirmReset ? (
              <div className="settings-confirm-actions">
                <span className="confirm-inline-text">sure?</span>
                <button type="button" className="btn btn-danger settings-confirm-btn"
                  disabled={resetting} onClick={handleResetDefaults}>
                  {resetting ? 'Resetting…' : 'Yes'}
                </button>
                <button type="button" className="icon-btn settings-confirm-btn"
                  onClick={() => setConfirmReset(false)}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="btn btn-danger-outline"
                onClick={() => { setConfirmReset(true); setResetDone(false); }}>
                Reset
              </button>
            )}
          </Row>
          {resetDone && (
            <Row title="" desc="" stack>
              <div className="settings-msg settings-msg-success">Settings restored to defaults.</div>
            </Row>
          )}
          <Row title="Delete all data" desc="Permanently remove every entry in your library.">
            <button className="btn btn-danger" type="button" onClick={() => setScreen('confirm-delete')}>Wipe Data</button>
          </Row>
        </Section>
        </>
        )}
      </div>
    </div>
    </LockContext.Provider>
  );
}

// Small immutable deep-merge for the local UI mirror.
function mergeDeep(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
