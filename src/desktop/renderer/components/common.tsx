import { useState, type ReactNode } from 'react';
import type { UiError } from '../../shared/ipc-contract.ts';
import type { ArtifactText } from '../../../core/session-history/session-history.ts';
import { formatBytes, statusTone } from '../lib/format.ts';

export function Pill({ value, label, title }: { value: string | null | undefined; label?: string; title?: string }) {
  return (
    <span className={`pill tone-${statusTone(value)}`} data-testid="pill" title={title}>
      <span className="pill-dot" aria-hidden="true" />
      {label ?? value ?? '—'}
    </span>
  );
}

export function Card({ title, children, actions, className }: { title?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

/** A readable error with its technical detail folded away behind "View details". */
export function ErrorPanel({ error, onDismiss }: { error: UiError; onDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="error-panel" role="alert">
      <div className="error-main">
        <strong className="error-title">{error.title}</strong>
        <span className="error-message">{error.message}</span>
      </div>
      <div className="error-actions">
        {error.details && (
          <button type="button" className="btn btn-link" onClick={() => setOpen((v) => !v)}>
            {open ? 'Ẩn chi tiết' : 'View details'}
          </button>
        )}
        {onDismiss && (
          <button type="button" className="btn btn-link" onClick={onDismiss} aria-label="Đóng">
            Đóng
          </button>
        )}
      </div>
      {open && error.details && <pre className="error-details">{error.details}</pre>}
    </div>
  );
}

/**
 * A collapsed-by-default section (technical details, raw output). Children are only
 * mounted while open, so nothing inside fetches or renders until the user asks for it.
 */
export function Disclosure({
  title,
  summary,
  children,
  testId,
  defaultOpen = false,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = `disclosure-${testId ?? title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className={`disclosure ${open ? 'open' : ''}`}>
      <button type="button" className="disclosure-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} data-testid={testId ? `${testId}-toggle` : undefined}>
        <span className="disclosure-chevron" aria-hidden="true">
          ▸
        </span>
        <span className="disclosure-title">{title}</span>
        {summary && <span className="disclosure-summary">{summary}</span>}
        <span className="disclosure-action">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="disclosure-body" id={id} data-testid={testId}>
          {children}
        </div>
      )}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** Path/size/hash line shown above a rendered or raw artifact — read-only, never editable. */
export function ArtifactMeta({ artifact, extra }: { artifact: ArtifactText; extra?: string }) {
  return (
    <p className="artifact-meta mono">
      {artifact.path} · {formatBytes(artifact.bytes)} · sha256 {artifact.sha256.slice(0, 16)}…{extra ? ` · ${extra}` : ''}
      {artifact.truncated && <span className="warn"> · hiển thị đã cắt bớt (file lớn)</span>}
    </p>
  );
}

/** An artifact's exact byte-for-byte text, unrendered — for "Raw" toggles everywhere. */
export function Raw({ artifact, testId }: { artifact: ArtifactText; testId?: string }) {
  return (
    <>
      <ArtifactMeta artifact={artifact} />
      <pre className="raw" data-testid={testId ?? 'artifact-raw'}>
        {artifact.text}
      </pre>
    </>
  );
}
