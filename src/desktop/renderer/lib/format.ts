export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('vi-VN', { hour12: false });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('vi-VN', { hour12: false });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Visual tone for a Core status string — presentation only. */
export type Tone = 'idle' | 'active' | 'paused' | 'success' | 'danger' | 'warning';

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'RUNNING':
    case 'EXECUTING':
    case 'REVIEWING':
      return 'active';
    case 'PAUSED':
      return 'paused';
    case 'DONE':
    case 'PASS':
      return 'success';
    case 'ERROR':
    case 'FAIL':
    case 'BLOCKED':
    case 'INTERRUPTED':
      return 'danger';
    case 'NEED_HUMAN':
    case 'STOPPED':
    case 'STOPPED_MAX_ITERATIONS':
    case 'WARNING':
    case 'UNKNOWN':
      return 'warning';
    default:
      return 'idle';
  }
}
