import { useState } from 'react';
import { useBridge } from '../state/BridgeProvider.tsx';
import { useNav } from '../state/Navigation.tsx';
import { Card, EmptyState, ErrorPanel } from './common.tsx';
import { JournalPanel } from './JournalPanel.tsx';
import { pickSession, SessionPicker, useSessions } from './SessionPicker.tsx';

/** JOURNAL — the Claude ⇄ ChatGPT conversation of one session, round by round (M4.2). */
export function JournalView() {
  const { snapshot } = useBridge();
  const { target } = useNav();
  const { sessions, error } = useSessions();
  const [picked, setPicked] = useState<string | null>(null);

  if (!snapshot?.project) return <EmptyState title="Chưa chọn project" />;
  if (error) return <ErrorPanel error={error} />;
  if (!sessions) return <p className="hint">Đang tải…</p>;
  if (sessions.length === 0) return <EmptyState title="Project chưa có session nào">Nhật ký phát triển xuất hiện ở đây sau khi bạn bắt đầu một run.</EmptyState>;

  const session = pickSession(sessions, picked, target?.runId ?? null)!;
  // The live session's journal is re-read as Core moves; finished sessions don't change.
  const live = snapshot.status?.runId === session.runId ? `${snapshot.status.iteration}|${snapshot.status.currentPhase ?? ''}|${snapshot.status.status}` : undefined;
  const initialIteration = !picked && target?.runId === session.runId ? (target.iteration ?? null) : null;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Development Journal</h1>
          <p className="page-sub">Claude ⇄ ChatGPT, round by round — prompts, reports, reviews and the next prompt.</p>
        </div>
        <SessionPicker sessions={sessions} value={session} onChange={setPicked} />
      </header>
      <Card className="journal-card">
        <JournalPanel key={session.runId} runId={session.runId} refreshKey={live} initialIteration={initialIteration} />
      </Card>
    </div>
  );
}
