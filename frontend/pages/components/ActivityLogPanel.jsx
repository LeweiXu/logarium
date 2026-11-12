import { useState, useEffect, useCallback } from 'react';
import { getActivity } from '../../api.jsx';
import { describeEvent, fmtDate, timeAgo } from '../../utils.jsx';

// ── ActivityLogPanel ──────────────────────────────────────────────────────────
// The full recorded history, every kind of change, newest first. The Dashboard's
// log is the short version (latest status move per entry); this is everything,
// which is where you go to answer "when did I actually rate that?".
//
// Batched edits arrive collapsed into one row carrying a count, so a bulk status
// change reads as one line instead of thirty.

const PAGE = 50;
const FILTERS = [
  ['',                                  'Everything'],
  ['created,status',                    'Status'],
  ['rating',                            'Ratings'],
  ['progress',                          'Progress'],
  ['list',                              'Lists'],
  ['meta,notes,total,completed_at',     'Edits'],
];

export default function ActivityLogPanel() {
  const [events,  setEvents]  = useState([]);
  const [filter,  setFilter]  = useState('');
  const [limit,   setLimit]   = useState(PAGE);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async (actions, want) => {
    setLoading(true);
    setError('');
    try {
      setEvents(await getActivity({ actions, limit: want }));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(filter, limit); }, [load, filter, limit]);

  function changeFilter(next) {
    setLimit(PAGE);
    setFilter(next);
  }

  return (
    <div className="activity-log-panel">
      <div className="settings-chip-row activity-log-filters">
        {FILTERS.map(([value, label]) => (
          <button key={label} type="button"
            className={`source-chip${filter === value ? ' is-on' : ''}`}
            onClick={() => changeFilter(value)}>
            <span className="source-box">{filter === value ? '[x]' : '[ ]'}</span>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="settings-msg settings-msg-error">{error}</div>}
      {loading && events.length === 0 && <p className="console-tool-note">Loading…</p>}
      {!loading && events.length === 0 && !error && (
        <p className="console-tool-note">Nothing recorded yet.</p>
      )}

      {events.length > 0 && (
        <div className="activity-log-rows">
          {events.map(event => {
            const backdated = Math.abs(new Date(event.recorded_at) - new Date(event.at)) > 86400000;
            return (
              <div key={event.id} className="activity-log-row">
                <span className="activity-log-action">{event.action}</span>
                <span className="activity-log-text">
                  {describeEvent(event)}
                  {backdated && (
                    <span className="activity-log-note"> (dated {fmtDate(event.at)})</span>
                  )}
                </span>
                <time className="activity-log-time" dateTime={event.recorded_at}
                  title={new Date(event.recorded_at).toLocaleString()}>
                  {timeAgo(event.recorded_at)}
                </time>
              </div>
            );
          })}
        </div>
      )}

      {events.length >= limit && (
        <div className="activity-log-actions">
          <button type="button" className="btn btn-outline" disabled={loading}
            onClick={() => setLimit(l => l + PAGE)}>
            {loading ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  );
}
