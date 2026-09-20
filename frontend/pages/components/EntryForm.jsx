import { useEffect, useMemo, useState } from 'react';
import { getCustomLists, fetchChapterCount, fetchImdbDetail } from '../../api.jsx';
import { ORIGINS, STATUSES, statusLabel, inferSourceFromUrl, roundToStep, visibleMediumsFromPrefs } from '../../utils.jsx';
import { usePreferences, DEFAULT_UI } from '../../preferences.jsx';
import { extensionNuSeries } from '../../extensionBridge.js';
import CustomListField from './CustomListField.jsx';
import CustomSelect from './CustomSelect.jsx';
import NumberStepper from './NumberStepper.jsx';
import { canonicalSource } from './searchSources.js';

function toDateInput(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

// Year choices for the completed-date picker — current year back 100 years.
const CURRENT_YEAR = new Date().getFullYear();
const COMPLETION_YEAR_OPTIONS = Array.from({ length: 101 }, (_, i) => {
  const y = String(CURRENT_YEAR - i);
  return { value: y, label: y };
});

export function entryToForm(entry = null) {
  return {
    title:           entry?.title           || '',
    medium:          entry?.medium          || '',
    origin:          entry?.origin          || '',
    status:          entry?.status          || 'current',
    year:            entry?.year            || '',
    rating:          entry?.rating          ?? '',
    progress:        entry?.progress        ?? '',
    total:           entry?.total           ?? '',
    cover_url:       entry?.cover_url       || '',
    notes:           entry?.notes           || '',
    genres:          entry?.genres          || '',
    completed_at:    entry?.completed_at ? toDateInput(entry.completed_at) : entry?.status === 'completed' ? today() : '',
    external_url:    entry?.external_url    || '',
    source:          entry?.source          || '',
    external_id:     entry?.external_id     || '',
    external_rating: entry?.external_rating ?? '',
    custom_list:     entry?.custom_list     || '',
  };
}

export function formToPayload(form, { isEdit = false } = {}) {
  const customList = (form.custom_list || '').trim();
  return {
    ...form,
    year:            form.year            !== '' ? parseInt(form.year)            : (isEdit ? null : undefined),
    rating:          form.rating          !== '' ? parseFloat(form.rating)        : (isEdit ? null : undefined),
    progress:        form.progress        !== '' ? parseInt(form.progress)        : (isEdit ? null : undefined),
    total:           form.total           !== '' ? parseInt(form.total)           : (isEdit ? null : undefined),
    external_rating: form.external_rating !== '' ? parseFloat(form.external_rating) : (isEdit ? null : undefined),
    completed_at:    form.completed_at    ? form.completed_at + 'T00:00:00Z'     : (isEdit ? null : undefined),
    custom_list:     customList !== '' ? customList                         : (isEdit ? null : undefined),
  };
}

export default function EntryForm({
  entry = null,
  onSubmit,
  onCancel,
  onDelete,
  submitLabel,
  savingLabel = '',
  cancelLabel = 'Cancel',
  leftAction = null,
  showDelete = false,
  changedFields = null,
}) {
  const isEdit = Boolean(entry?.id);

  // Marker shown next to a label when a refresh fetched a value that differs
  // from the saved entry. The old value rides along in the tooltip.
  const diffTag = (field) => {
    if (!changedFields || !(field in changedFields)) return null;
    const was = changedFields[field] === '' || changedFields[field] == null ? '—' : changedFields[field];
    return <span className="form-changed-tag" title={`was: ${was}`}>changed</span>;
  };
  const { prefs } = usePreferences();
  const visibleMediums = useMemo(() => visibleMediumsFromPrefs(prefs), [prefs]);
  const ratingStep = prefs.rating_step ?? DEFAULT_UI.rating_step;
  const [form, setFormState] = useState(() => entryToForm(entry));
  const [customLists, setCustomLists] = useState([]);
  const [lastListWarning, setLastListWarning] = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [deleting,      setDeleting]      = useState(false);
  const [err,           setErr]           = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const setField = (k, v) => {
    if (k === 'custom_list') setLastListWarning(false);
    setFormState(f => {
      const next = { ...f, [k]: v };
      if (k === 'status' && v === 'completed') {
        if (!next.completed_at) next.completed_at = today();
        if (next.total !== '') next.progress = next.total;
      }
      if (k === 'status' && v !== 'completed') next.completed_at = '';
      if (k === 'total' && f.status === 'completed' && v !== '') next.progress = v;
      if (k === 'external_url') next.source = inferSourceFromUrl(v);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    getCustomLists()
      .then(lists => { if (!cancelled) setCustomLists(Array.isArray(lists) ? lists : []); })
      .catch(() => { if (!cancelled) setCustomLists([]); });
    return () => { cancelled = true; };
  }, []);

  // While an on-add field is being fetched from another source we flag it so the
  // relevant input shows a "fetching…" placeholder instead of looking empty.
  // 'total' = manga chapters / IMDb episodes; 'imdb' also fills the source rating.
  const [fetching, setFetching] = useState('');

  // For a MAL manga being added with no chapter total (MAL leaves ongoing
  // series blank), fetch the latest chapter count from MangaUpdates on demand.
  useEffect(() => {
    if (isEdit) return;
    if (canonicalSource(entry?.source) !== 'mal' || entry?.medium !== 'Manga' || entry?.total) return;
    if (!entry?.title) return;
    let cancelled = false;
    setFetching('total');
    fetchChapterCount(entry.title)
      .then(res => {
        const total = res?.total;
        if (!cancelled && total) {
          setFormState(f => (f.total === '' ? { ...f, total: String(total) } : f));
        }
      })
      .catch(() => { /* non-critical */ })
      .finally(() => { if (!cancelled) setFetching(''); });
    return () => { cancelled = true; };
  }, []);

  // IMDb search results come from the suggestion endpoint, which has no rating or
  // episode count — fetch those (plus any blank cover/genres/year) on demand when
  // adding an IMDb-sourced Film/TV entry, mirroring the chapter-count fill above.
  useEffect(() => {
    if (isEdit) return;
    if (entry?.source !== 'imdb' || !entry?.external_id) return;
    if (entry?.external_rating && entry?.total) return;
    let cancelled = false;
    setFetching('imdb');
    fetchImdbDetail(entry.external_id)
      .then(d => {
        if (cancelled || !d) return;
        setFormState(f => ({
          ...f,
          external_rating: f.external_rating === '' && d.external_rating != null ? String(d.external_rating) : f.external_rating,
          total:           f.total === ''   && d.total != null  ? String(d.total) : f.total,
          year:            f.year === ''     && d.year != null   ? String(d.year) : f.year,
          cover_url:       f.cover_url || d.cover_url || '',
          genres:          f.genres || d.genres || '',
        }));
      })
      .catch(() => { /* non-critical */ })
      .finally(() => { if (!cancelled) setFetching(''); });
    return () => { cancelled = true; };
  }, []);

  function isRemovingLastEntryFromList(nextList) {
    const currentList = entry?.custom_list || '';
    if (!isEdit || !currentList || currentList === nextList) return false;
    const currentMeta = customLists.find(list => list.name === currentList);
    return currentMeta?.count === 1;
  }

  async function upgradeNovelUpdatesCover(nextForm) {
    const source = nextForm.source || inferSourceFromUrl(nextForm.external_url);
    if (isEdit || source !== 'novelupdates' || !nextForm.external_url) return nextForm;
    try {
      const detail = await extensionNuSeries(nextForm.external_url);
      const fullCover = detail?.cover_url || '';
      return fullCover ? { ...nextForm, cover_url: fullCover } : nextForm;
    } catch {
      return nextForm;
    }
  }

  async function submitForm(skipWarning = false) {
    if (!form.title.trim()) { setErr('Title is required'); return; }
    const nextList = (form.custom_list || '').trim();
    if (isRemovingLastEntryFromList(nextList) && !skipWarning) {
      setLastListWarning(true);
      setErr('');
      return;
    }
    setSaving(true); setErr('');
    setLastListWarning(false);
    try {
      const nextForm = await upgradeNovelUpdatesCover({ ...form });
      // Snap the rating to the configured granularity before saving (covers a
      // typed value the user never blurred out of).
      const rating = nextForm.rating === '' ? '' : String(roundToStep(nextForm.rating, ratingStep));
      await onSubmit({ ...nextForm, rating });
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    await submitForm(false);
  }

  async function handleDelete() {
    if (!onDelete) return;
    setDeleting(true); setErr('');
    try {
      await onDelete(entry.id);
    } catch (ex) {
      setErr(ex.message);
      setDeleting(false);
    }
  }

  return (
    <>
    <form onSubmit={handleSubmit}>
      <div className="form-row">
        <label className="form-label">Title * {diffTag('title')}</label>
        <input className="form-input" value={form.title}
          placeholder="Title"
          onChange={e => setField('title', e.target.value)} />
      </div>

      <div className="form-row-2 entry-form-spaced">
        <div>
          <label className="form-label">Medium {diffTag('medium')}</label>
          <CustomSelect
            value={form.medium}
            options={[
              { value: '', label: '-' },
              ...visibleMediums.map(medium => ({ value: medium, label: medium })),
            ]}
            onChange={value => setField('medium', value)}
            maxVisible={visibleMediums.length + 1}
            ariaLabel="Medium"
          />
        </div>
        <div>
          <label className="form-label">Status</label>
          <CustomSelect
            value={form.status}
            options={STATUSES.map(status => ({ value: status, label: statusLabel(status) }))}
            onChange={value => setField('status', value)}
            ariaLabel="Status"
          />
        </div>
      </div>

      <div className="form-row entry-form-spaced">
        <label className="form-label">Custom List</label>
        <CustomListField
          value={form.custom_list}
          onChange={v => setField('custom_list', v)}
          lists={customLists}
        />
      </div>

      {form.status === 'completed' && (
        <div className="form-row-2 entry-form-spaced">
          <div>
            <label className="form-label">Completed Date</label>
            <input className="form-input" type="date" value={form.completed_at}
              onChange={e => setField('completed_at', e.target.value)} />
          </div>
          <div>
            <label className="form-label">Completion Year</label>
            <div className="entry-form-completion-row">
              <CustomSelect
                value={form.completed_at?.slice(0, 4) || ''}
                options={COMPLETION_YEAR_OPTIONS}
                onChange={year => {
                  // Keep the existing month/day when only the year changes;
                  // default to Jan 1 if there's no valid date yet.
                  const rest = (form.completed_at && form.completed_at.length >= 10)
                    ? form.completed_at.slice(4)
                    : '-01-01';
                  setField('completed_at', `${year}${rest}`);
                }}
                placeholder="Year"
                maxVisible={6}
                ariaLabel="Completion year"
                containerClassName="entry-form-completion-select"
              />
              <button
                type="button"
                className="icon-btn entry-form-randomize"
                title="Randomize day and month, keep year"
                onClick={() => {
                  // Year comes from the existing value if present, otherwise the
                  // entry year, otherwise today.
                  const existing = form.completed_at ? new Date(form.completed_at) : null;
                  const year = (existing && !isNaN(existing))
                    ? existing.getFullYear()
                    : (parseInt(form.year, 10) || new Date().getFullYear());
                  const month  = Math.floor(Math.random() * 12) + 1;             // 1–12
                  const lastDay = new Date(year, month, 0).getDate();             // last day of that month
                  const day    = Math.floor(Math.random() * lastDay) + 1;        // 1–lastDay
                  const mm = String(month).padStart(2, '0');
                  const dd = String(day).padStart(2, '0');
                  setField('completed_at', `${year}-${mm}-${dd}`);
                }}
              >
                Randomize
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="form-row-2 entry-form-spaced">
        <div>
          <label className="form-label">Origin {diffTag('origin')}</label>
          <CustomSelect
            value={form.origin}
            options={[
              { value: '', label: '-' },
              ...ORIGINS.map(origin => ({ value: origin, label: origin })),
            ]}
            onChange={value => setField('origin', value)}
            ariaLabel="Origin"
          />
        </div>
        <div>
          <label className="form-label">Year {diffTag('year')}</label>
          <input className="form-input" type="number" value={form.year}
            placeholder="2024"
            onChange={e => setField('year', e.target.value)} />
        </div>
      </div>

      <div className="form-row-2 entry-form-spaced">
        <div>
          <label className="form-label">Progress</label>
          <input className="form-input" type="number" min="0" value={form.progress}
            placeholder="0"
            onChange={e => setField('progress', e.target.value)} />
        </div>
        <div>
          <label className="form-label">Total {diffTag('total')}</label>
          <input className="form-input" type="number" min="0" value={form.total}
            placeholder={fetching ? 'fetching…' : '12'}
            onChange={e => setField('total', e.target.value)} />
        </div>
      </div>

      <div className="form-row-2 entry-form-spaced">
        <div>
          <label className="form-label">Rating (0-10)</label>
          <NumberStepper className="form-stepper" value={form.rating} step={ratingStep}
            min={0} max={10} placeholder="-" ariaLabel="Rating"
            onChange={v => setField('rating', v)}
            onCommit={() => setField('rating', form.rating === '' ? '' : String(roundToStep(form.rating, ratingStep)))} />
        </div>
        <div>
          <label className="form-label">Source Rating {diffTag('external_rating')}</label>
          <input className="form-input" type="number" min="0" max="100" step="0.1"
            value={form.external_rating} placeholder={fetching === 'imdb' ? 'fetching…' : '-'}
            onChange={e => setField('external_rating', e.target.value)} />
        </div>
      </div>

      <div className="form-row">
        <label className="form-label">Cover URL {diffTag('cover_url')}</label>
        <input className="form-input" value={form.cover_url}
          placeholder="https://..."
          onChange={e => setField('cover_url', e.target.value)} />
      </div>

      <div className="form-row">
        <label className="form-label">Source URL {diffTag('external_url')}</label>
        <input className="form-input" value={form.external_url}
          placeholder="https://novelupdates.com/series/..."
          onChange={e => setField('external_url', e.target.value)} />
        {form.source && (
          <span className="entry-form-source">
            Source: {form.source}
          </span>
        )}
      </div>

      <div className="form-row">
        <label className="form-label">Genres {diffTag('genres')}</label>
        <input className="form-input" value={form.genres}
          placeholder="e.g. Action, Comedy, Drama"
          onChange={e => setField('genres', e.target.value)}
          onBlur={e => setField('genres',
            e.target.value.split(',').map(s => s.trim()).filter(Boolean).join(', ')
          )}
        />
      </div>

      <div className="form-row">
        <label className="form-label">Notes</label>
        <textarea rows={2} value={form.notes}
          placeholder="Optional notes..."
          onChange={e => setField('notes', e.target.value)}
          className="form-input entry-form-notes" />
      </div>

      {err && <div className="entry-form-error">{err}</div>}

      <div className="entry-form-actions">
        <div>
          {showDelete && isEdit && (!confirmDelete
            ? <button type="button" className="btn btn-danger-outline"
                onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            : <span className="entry-form-delete-confirm">
                Confirm?
                <button type="button" className="btn btn-danger"
                  onClick={handleDelete} disabled={deleting}>
                  {deleting ? '...' : 'Yes, delete'}
                </button>
                <button type="button" className="btn btn-outline"
                  onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </span>
          )}
          {!showDelete && leftAction}
        </div>
        <div className="entry-form-primary-actions">
          {onCancel && <button type="button" className="btn btn-outline" onClick={onCancel}>{cancelLabel}</button>}
          <button type="submit" className="btn" disabled={saving}>
            {saving ? (savingLabel || (isEdit ? 'Saving...' : 'Adding...')) : submitLabel || (isEdit ? 'Save' : 'Add Entry')}
          </button>
        </div>
      </div>

    </form>

    {lastListWarning && (
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setLastListWarning(false)}>
        <div className="modal confirm-modal">
          <div className="modal-header">
            <span className="modal-title">Custom List Will Be Removed</span>
            <button className="icon-btn" onClick={() => setLastListWarning(false)}>✕</button>
          </div>
          <div className="modal-body">
            <p className="confirm-copy">
              "{entry.custom_list}" only contains this entry. Saving will remove the entry from that list, so the custom list will disappear.
            </p>
            <div className="confirm-actions">
              <button className="btn btn-outline" type="button" onClick={() => setLastListWarning(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" type="button" onClick={() => submitForm(true)}>
                Save Anyway
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
