import { redactSecrets } from '../../core/security/redact.ts';
import type { BridgeEvent } from '../../core/observability/events.ts';
import type { DoctorReport } from '../../core/preflight/doctor.ts';
import type { UiError } from '../shared/ipc-contract.ts';

/** Everything free-text that crosses into the renderer (events, errors, doctor details)
 * goes through Core's redactor first (M4 §9, §24). Artifacts are deliberately NOT
 * redacted — the viewer must show exactly what was sent. */

export function redactEvent(event: BridgeEvent): BridgeEvent {
  return event.detail === undefined ? event : { ...event, detail: redactSecrets(event.detail) };
}

export function redactUiError(error: UiError): UiError {
  return {
    code: error.code,
    title: redactSecrets(error.title),
    message: redactSecrets(error.message),
    ...(error.details === undefined ? {} : { details: redactSecrets(error.details) }),
  };
}

export function redactDoctorReport(report: DoctorReport): DoctorReport {
  return { overall: report.overall, checks: report.checks.map((c) => ({ ...c, detail: redactSecrets(c.detail) })) };
}
