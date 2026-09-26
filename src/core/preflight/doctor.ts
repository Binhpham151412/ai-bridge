export type DoctorCheckStatus = 'PASS' | 'FAIL' | 'WARNING' | 'BLOCKED' | 'UNKNOWN';

export interface DoctorCheckOutcome {
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorCheckResult extends DoctorCheckOutcome {
  name: string;
}

export interface DoctorCheckDefinition {
  name: string;
  run: () => Promise<DoctorCheckOutcome>;
}

export type DoctorOverallStatus = 'PASS' | 'FAIL' | 'BLOCKED';

export interface DoctorReport {
  checks: DoctorCheckResult[];
  overall: DoctorOverallStatus;
}

/**
 * Runs every check (never skips one because an earlier one failed) and never lets a
 * check that throws crash the whole run — an uncaught error becomes a FAIL with the
 * error message as detail. Overall status: BLOCKED (cost guard) beats FAIL, which
 * beats WARNING/UNKNOWN, which beats PASS.
 */
export async function runDoctorChecks(checks: DoctorCheckDefinition[]): Promise<DoctorReport> {
  const results: DoctorCheckResult[] = [];
  for (const check of checks) {
    try {
      const outcome = await check.run();
      results.push({ name: check.name, ...outcome });
    } catch (err) {
      results.push({ name: check.name, status: 'FAIL', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  let overall: DoctorOverallStatus = 'PASS';
  if (results.some((r) => r.status === 'FAIL' || r.status === 'UNKNOWN')) overall = 'FAIL';
  if (results.some((r) => r.status === 'BLOCKED')) overall = 'BLOCKED';

  return { checks: results, overall };
}
