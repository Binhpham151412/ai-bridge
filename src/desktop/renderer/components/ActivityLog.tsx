import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { BridgeEvent } from '../../../core/observability/events.ts';
import { describeEvent, eventKey, humanizeEvent } from '../lib/events-store.ts';
import { formatTime } from '../lib/format.ts';

/** Memoized per event object: `mergeEvents` keeps existing event objects by reference,
 * so a new event renders one new row instead of re-rendering the whole (bounded) log. */
const ActivityRow = memo(function ActivityRow({ event }: { event: BridgeEvent }) {
  const { label, level } = describeEvent(event);
  return (
    <div className={`activity-row level-${level}`} data-testid="activity-row">
      <span className="activity-time mono">{formatTime(event.timestamp)}</span>
      <span className="activity-type">{label}</span>
      <span className="activity-iter mono">{event.iteration > 0 ? `#${event.iteration}` : ''}</span>
      <span className="activity-msg">{event.detail ?? ''}</span>
    </div>
  );
});

/** Plain-language row for the RUN screen: time, what happened, which round. The Core
 * detail line only appears for warnings/errors (see `humanizeEvent`). */
const FeedRow = memo(function FeedRow({ event }: { event: BridgeEvent }) {
  const { label, level, detail } = humanizeEvent(event);
  return (
    <div className={`feed-row level-${level}`} data-testid="activity-row">
      <span className="feed-time mono">{formatTime(event.timestamp)}</span>
      <span className="feed-label">
        {label}
        {detail && <span className="feed-detail">{detail}</span>}
      </span>
      <span className="feed-round">{event.iteration > 0 ? `Round ${event.iteration}` : ''}</span>
    </div>
  );
});

/** Live activity (M4 §9): auto-scrolls while the user is at the bottom, stops
 * following as soon as they scroll up, resumes when they scroll back down.
 * `variant="feed"` is the plain-language RUN view; the default is the technical log. */
export function ActivityLog({ events, emptyText = 'Chưa có hoạt động.', variant = 'technical' }: { events: readonly BridgeEvent[]; emptyText?: string; variant?: 'technical' | 'feed' }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [events, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const Row = variant === 'feed' ? FeedRow : ActivityRow;
  return (
    <div className="activity">
      <div className={`activity-list ${variant === 'feed' ? 'feed' : ''}`} ref={listRef} onScroll={onScroll} data-testid="activity-list" tabIndex={0} aria-label="Activity">
        {events.length === 0 && <p className="hint">{emptyText}</p>}
        {events.map((e) => (
          <Row key={eventKey(e)} event={e} />
        ))}
      </div>
      {!follow && (
        <button type="button" className="btn btn-small activity-follow" onClick={() => setFollow(true)}>
          ↓ Theo dõi mới nhất
        </button>
      )}
    </div>
  );
}
