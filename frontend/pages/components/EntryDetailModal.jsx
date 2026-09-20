import { useState } from 'react';
import { deleteEntry, fetchByUrl, fetchChapterCount, fetchImdbDetail } from '../../api.jsx';
import { useShare } from '../../share.jsx';
import { statusLabel, fmtDate, progressLabel, onCoverErrorPlaceholder } from '../../utils.jsx';
import { coverImgUrl } from '../../api.jsx';
import EntryFormModal from './EntryFormModal.jsx';
import { entryToForm } from './EntryForm.jsx';
import { canonicalSource, resultToEntry } from './searchSources.js';

// Fields the source query can refresh. User-owned fields (status, rating,
// progress, notes, custom_list, completed_at) are never touched by a refresh.
const REFRESHABLE_FIELDS = [
  'title', 'medium', 'origin', 'year', 'total', 'cover_url',
  'external_url', 'genres', 'external_rating', 'external_id', 'source',
];

// Some providers only give a page's core data and rely on a secondary lookup to
// fill the rest — the same enrichment EntryForm does on add, replicated here so a
// refresh gets those fields too (add-time effects are gated to non-edit). Mutates
// `merged` in place, filling only blanks so it never clobbers fetched values.
async function enrichFromSecondarySources(merged) {
  // MAL manga often ships no chapter total, so pull it from MangaUpdates.
  if (canonicalSource(merged.source) === 'mal' && merged.medium === 'Manga' && !merged.total && merged.title) {
    try {
      const res = await fetchChapterCount(merged.title);
      if (res?.total) merged.total = res.total;
    } catch { /* best-effort */ }
  }
  // IMDb suggestions carry no rating/episode count — resolve them by id.
  if (merged.source === 'imdb' && merged.external_id && (!merged.external_rating || !merged.total)) {
    try {
      const d = await fetchImdbDetail(merged.external_id);
      if (d) {
        if (!merged.external_rating && d.external_rating != null) merged.external_rating = d.external_rating;
        if (!merged.total && d.total != null) merged.total = d.total;
        if (!merged.year && d.year != null) merged.year = d.year;
        if (!merged.cover_url && d.cover_url) merged.cover_url = d.cover_url;
        if (!merged.genres && d.genres) merged.genres = d.genres;
      }
    } catch { /* best-effort */ }
  }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export default function EntryDetailModal({ entry, onClose, onUpdated, onDeleted, initialEditing = false }) {
  // A shared profile can open an entry to read it, but never to change it.
  const { isShare } = useShare();
  const [editing,         setEditing]         = useState(initialEditing && !isShare);
  const [current,         setCurrent]         = useState(entry);
  const [confirmDelete,   setConfirmDelete]   = useState(false);
  const [deleting,        setDeleting]        = useState(false);
  const [deleteError,     setDeleteError]     = useState('');
  const [refreshing,      setRefreshing]      = useState(false);
  const [refreshError,    setRefreshError]    = useState('');
  // When set, the edit modal opens pre-filled with freshly-fetched source data.
  // `changed` maps each differing field to its previous (saved) value.
  const [refreshData,     setRefreshData]     = useState(null);

  async function handleRefresh() {
    if (!current.external_url) {
      setRefreshError('This entry has no source URL to refresh from.');
      return;
    }
    setRefreshing(true);
    setRefreshError('');
    try {
      const results = await fetchByUrl(current.external_url);
      const item = Array.isArray(results) ? results[0] : results;
      if (!item) {
        setRefreshError('The source returned nothing for this entry.');
        return;
      }
      // Overlay only the source-derived fields that actually came back, so a
      // sparse result never wipes existing data with blanks.
      const fetched = resultToEntry(item);
      const merged = { ...current };
      for (const field of REFRESHABLE_FIELDS) {
        const value = fetched[field];
        if (value !== '' && value != null) merged[field] = value;
      }
      await enrichFromSecondarySources(merged);
      // Diff in form representation so types line up (e.g. year 2019 vs "2019").
      const before = entryToForm(current);
      const after  = entryToForm(merged);
      const changed = {};
      for (const field of REFRESHABLE_FIELDS) {
        if (String(before[field] ?? '') !== String(after[field] ?? '')) {
          changed[field] = before[field] ?? '';
        }
      }
      setRefreshData({ entry: merged, changed });
      setEditing(true);
    } catch (err) {
      setRefreshError(err.message || String(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteEntry(current.id);
      onDeleted?.(current.id);
      onClose();
    } catch (err) {
      setDeleteError(err.message || String(err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (editing) {
    return (
      <EntryFormModal
        entry={refreshData?.entry || current}
        changedFields={refreshData?.changed}
        onClose={() => { setEditing(false); setRefreshData(null); }}
        onSaved={(updated) => { setCurrent(updated); onUpdated(updated); setEditing(false); setRefreshData(null); }}
        onDeleted={(id) => { onDeleted(id); onClose(); }}
      />
    );
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">{current.title}</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {current.cover_url && (
            <div className="entry-detail-cover-wrap">
              <img src={coverImgUrl(current.cover_url, 'full', current.cover_key)} alt=""
                referrerPolicy="no-referrer"
                className="entry-detail-cover"
                onError={onCoverErrorPlaceholder} />
            </div>
          )}

          <div className="form-row-2 entry-detail-row">
            <div>
              <div className="form-label">Medium</div>
              <div>{current.medium || '—'}</div>
            </div>
            <div>
              <div className="form-label">Status</div>
              <div><span className={`badge badge-${current.status}`}>{statusLabel(current.status)}</span></div>
            </div>
          </div>

          <div className="form-row-2 entry-detail-row">
            <div>
              <div className="form-label">Origin</div>
              <div>{current.origin || '—'}</div>
            </div>
            <div>
              <div className="form-label">Year</div>
              <div>{current.year || '—'}</div>
            </div>
          </div>

          <div className="form-row-2 entry-detail-row">
            <div>
              <div className="form-label">Progress</div>
              <div>{progressLabel(current)}</div>
            </div>
            <div>
              <div className="form-label">Rating</div>
              <div>{current.rating != null ? `${current.rating}/10` : '—'}</div>
            </div>
          </div>

          <div className="entry-detail-row">
            <div className="form-label">Custom List</div>
            <div>{current.custom_list || '—'}</div>
          </div>

          {(current.genres || current.external_rating != null) && (
            <div className="form-row-2 entry-detail-row">
              <div>
                <div className="form-label">Genres</div>
                <div className="entry-detail-small">{current.genres || '—'}</div>
              </div>
              <div>
                <div className="form-label">Source Rating</div>
                <div>{current.external_rating != null ? `${current.external_rating}/10` : '—'}</div>
              </div>
            </div>
          )}

          {current.completed_at && (
            <div className="entry-detail-row">
              <div className="form-label">Completed Date</div>
              <div>{fmtDate(current.completed_at)}</div>
            </div>
          )}

          {current.notes && (
            <div className="entry-detail-row">
              <div className="form-label">Notes</div>
              <div className="entry-detail-notes">
                {current.notes}
              </div>
            </div>
          )}

          {current.external_url && (
            <div className="entry-detail-row">
              <div className="form-label">External Source</div>
              <a href={current.external_url} target="_blank" rel="noopener noreferrer"
                className="entry-detail-external">
                {cleanUrl(current.external_url)}
              </a>
            </div>
          )}

          <div className="entry-detail-timestamps">
            <span>Added: {fmtDate(current.created_at)}</span>
            <span>Updated: {fmtDate(current.updated_at)}</span>
          </div>

          {(deleteError || refreshError) && (
            <div className="settings-msg settings-msg-error entry-detail-error">
              {deleteError || refreshError}
            </div>
          )}
          {!isShare && (
          <div className="entry-detail-actions">
            {confirmDelete ? (
              <div className="entry-detail-confirm">
                <span className="confirm-inline-text">sure?</span>
                <button type="button" className="btn btn-danger"
                  onClick={handleDelete} disabled={deleting}>
                  {deleting ? '…' : 'Yes, delete'}
                </button>
                <button type="button" className="btn btn-outline"
                  onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-danger-outline"
                onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
            <div className="entry-detail-primary-actions">
              <button type="button" className="btn btn-outline"
                onClick={handleRefresh}
                disabled={refreshing || !current.external_url}
                title={current.external_url
                  ? 'Re-fetch details from the source and review changes'
                  : 'No source URL to refresh from'}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
              <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
