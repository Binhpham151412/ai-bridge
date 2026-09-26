import { useState } from 'react';
import type { DoctorReport } from '../../../core/preflight/doctor.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
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

/** System Check (M4 §14): Core's own `doctor()` result, rendered — no second doctor. */
export function SystemCheck() {
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
          <table className="table" data-testid="doctor-table">
            <tbody>
              {report.checks.map((c) => (
                <tr key={c.name}>
                  <td className="doctor-name">{LABELS[c.name] ?? c.name}</td>
                  <td>
                    <Pill value={c.status} />
                  </td>
                  <td className="mono small">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Permission mode của Claude luôn là acceptEdits (Core không bao giờ cho bỏ qua kiểm tra quyền) — đây là quy tắc của Core, không phải một mục doctor riêng.</p>
        </>
      )}
    </Card>
  );
}
