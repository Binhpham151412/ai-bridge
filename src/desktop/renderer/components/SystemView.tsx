import { useEffect, useState } from 'react';
import type { DoctorCheckResult, DoctorReport } from '../../../core/preflight/doctor.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatBytes } from '../lib/format.ts';
import { Card, EmptyState, ErrorPanel, Pill } from './common.tsx';

const LABELS: Record<string, string> = {
  node: 'Node',
  'api-key-env': 'Cost guard (không API key)',
  'claude-cli': 'Claude CLI',
  'claude-auth': 'Authentication — Claude',
  'codex-cli': 'Codex CLI',
  'codex-auth': 'Authentication — ChatGPT/Codex',
  git: 'Git',
  'project-directory': 'Project',
  config: 'Configuration',
  'git-repository': 'Git repository',
};

/** Doctor checks grouped by what they are about. Any check Core adds later that is not
 * listed here still shows, under "Other". */
const GROUPS: { title: string; names: string[] }[] = [
  { title: 'Claude Code', names: ['claude-cli', 'claude-auth'] },
  { title: 'ChatGPT / Codex', names: ['codex-cli', 'codex-auth'] },
  { title: 'Project', names: ['project-directory', 'config', 'git-repository'] },
  { title: 'Environment', names: ['node', 'git', 'api-key-env'] },
];

function grouped(checks: DoctorCheckResult[]): { title: string; checks: DoctorCheckResult[] }[] {
  const known = new Set(GROUPS.flatMap((g) => g.names));
  const out = GROUPS.map((g) => ({ title: g.title, checks: g.names.map((n) => checks.find((c) => c.name === n)).filter((c): c is DoctorCheckResult => c !== undefined) }));
  out.push({ title: 'Other', checks: checks.filter((c) => !known.has(c.name)) });
  return out.filter((g) => g.checks.length > 0);
}

/** Versions the renderer itself can see (its user-agent string) — nothing asked of Main. */
function runtimeFromUserAgent(ua: string): { electron: string | null; chromium: string | null } {
  return { electron: /Electron\/([\d.]+)/.exec(ua)?.[1] ?? null, chromium: /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? null };
}

function SystemCheckCard() {
  const { api, snapshot } = useBridge();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [running, setRunning] = useState(false);

  if (!snapshot?.project) return <EmptyState title="Chưa chọn project">System Check chạy cho một project cụ thể.</EmptyState>;

  const run = async () => {
    setRunning(true);
    const res = await api.doctor();
    setRunning(false);
    if (res.ok) {
      setReport(res.data);
      setError(null);
    } else setError(res.error);
  };

  return (
    <Card
      title="System check"
      actions={
        <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={running} data-testid="btn-doctor">
          {running ? 'Đang kiểm tra…' : report ? 'Kiểm tra lại' : 'Chạy kiểm tra'}
        </button>
      }
    >
      {error && <ErrorPanel error={error} />}
      {!report && !error && <p className="hint">Chạy doctor của Core: Node, cost guard, Claude/Codex CLI + authentication, git, project, cấu hình.</p>}
      {report && (
        <>
          <div className="doctor-overall">
            Overall <Pill value={report.overall} />
          </div>
          <table className="table doctor-table" data-testid="doctor-table">
            {grouped(report.checks).map((g) => (
              <tbody key={g.title}>
                <tr className="doctor-group">
                  <th colSpan={3} scope="colgroup">
                    {g.title}
                  </th>
                </tr>
                {g.checks.map((c) => (
                  <tr key={c.name}>
                    <td className="doctor-name">{LABELS[c.name] ?? c.name}</td>
                    <td>
                      <Pill value={c.status} />
                    </td>
                    <td className="mono small">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          <p className="hint">Permission mode của Claude luôn là acceptEdits (Core không bao giờ cho bỏ qua kiểm tra quyền) — đây là quy tắc của Core, không phải một mục doctor riêng.</p>
        </>
      )}
    </Card>
  );
}

/** SYSTEM — the technical environment: Core's doctor, runtime versions, log handling and
 * the security/cost model. No credentials are read or shown; auth status is exactly
 * what the CLIs' own status commands reported to Core's doctor. */
export function SystemView() {
  const { api } = useBridge();
  const [maxLogBytes, setMaxLogBytes] = useState<number | null>(null);
  const runtime = runtimeFromUserAgent(navigator.userAgent);

  useEffect(() => {
    let active = true;
    void api.getSettings().then((res) => {
      if (active && res.ok) setMaxLogBytes(res.data.logs.maxFileBytes);
    });
    return () => {
      active = false;
    };
  }, [api]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>System</h1>
          <p className="page-sub">CLI availability, sign-in status, runtime and logs.</p>
        </div>
      </header>
      <SystemCheckCard />
      <div className="two-col">
        <Card title="App runtime">
          <dl className="kv" data-testid="runtime">
            <dt>Electron</dt>
            <dd className="mono">{runtime.electron ?? '—'}</dd>
            <dt>Chromium</dt>
            <dd className="mono">{runtime.chromium ?? '—'}</dd>
            <dt>Platform</dt>
            <dd className="mono">{navigator.platform || '—'}</dd>
          </dl>
          <p className="hint">Phiên bản do renderer tự đọc (user agent). Node của Core: xem mục Environment trong System check.</p>
        </Card>
        <Card title="Logs">
          <p>
            Core ghi <span className="mono">.ai-bridge/logs/events.jsonl</span> và <span className="mono">ai-bridge.log</span> trong project, tự xoay vòng khi vượt {maxLogBytes === null ? '—' : formatBytes(maxLogBytes)}. Không cấu hình
            được (quy tắc của Core).
          </p>
        </Card>
      </div>
      <Card title="Bảo mật & chi phí">
        <p>
          AI Bridge dùng Claude CLI và Codex CLI với đăng nhập sẵn có của bạn. Ứng dụng không hỏi, không lưu API key, token, mật khẩu hay credential nào, và không gửi dữ liệu ra ngoài (không telemetry).
          Chi phí bổ sung: $0.
        </p>
      </Card>
    </div>
  );
}
