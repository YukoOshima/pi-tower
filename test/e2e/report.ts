export type Verdict = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly evidence: readonly string[];
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

export function addUsage(into: Usage, from: Partial<Usage>): void {
  into.input += from.input ?? 0;
  into.output += from.output ?? 0;
  into.cacheRead += from.cacheRead ?? 0;
  into.cacheWrite += from.cacheWrite ?? 0;
  into.total += from.total ?? 0;
  into.cost += from.cost ?? 0;
}

export function formatUsage(usage: Usage): string {
  return `${String(usage.total)} tokens (input ${String(usage.input)}, output ${String(usage.output)}, cache read ${String(usage.cacheRead)}, cache write ${String(usage.cacheWrite)}), cost $${usage.cost.toFixed(4)}`;
}

export class ScenarioReport {
  readonly id: string;
  readonly title: string;
  readonly mandatory: boolean;
  readonly checks: CheckResult[] = [];
  readonly evidence: string[] = [];
  readonly usageByRole = new Map<string, Usage>();
  verdict: Verdict = 'pass';
  error: string | undefined;
  skippedReason: string | undefined;
  durationMs = 0;

  constructor(id: string, title: string, mandatory: boolean) {
    this.id = id;
    this.title = title;
    this.mandatory = mandatory;
  }

  check(name: string, ok: boolean, evidence: string | readonly string[] = []): boolean {
    const lines = typeof evidence === 'string' ? [evidence] : [...evidence];
    this.checks.push({ name, ok, evidence: lines });
    if (!ok) this.verdict = 'fail';
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(`  [${this.id}] ${mark} ${name}`);
    for (const line of lines) console.log(`  [${this.id}]      ${line}`);
    return ok;
  }

  note(line: string): void {
    this.evidence.push(line);
    console.log(`  [${this.id}] · ${line}`);
  }

  fail(error: unknown): void {
    this.verdict = 'fail';
    this.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  [${this.id}] ERROR ${this.error}`);
  }

  skip(reason: string): void {
    this.verdict = 'skipped';
    this.skippedReason = reason;
    console.log(`  [${this.id}] SKIPPED ${reason}`);
  }

  addUsage(role: string, usage: Partial<Usage>): void {
    const current = this.usageByRole.get(role) ?? emptyUsage();
    addUsage(current, usage);
    this.usageByRole.set(role, current);
  }

  totalUsage(): Usage {
    const total = emptyUsage();
    for (const usage of this.usageByRole.values()) addUsage(total, usage);
    return total;
  }
}

export function renderReport(reports: readonly ScenarioReport[], header: readonly string[]): string {
  const lines: string[] = ['# pi-tower live e2e report', '', ...header, ''];
  const total = emptyUsage();
  lines.push('| Scenario | Verdict | Checks | Wall time | Cost |', '| -- | -- | -- | -- | -- |');
  for (const report of reports) {
    const passed = report.checks.filter((check) => check.ok).length;
    const cost = report.usageByRole.size === 0 ? 'n/a' : `$${report.totalUsage().cost.toFixed(4)}`;
    lines.push(`| ${report.id} ${report.title} | ${report.verdict} | ${String(passed)}/${String(report.checks.length)} | ${(report.durationMs / 1000).toFixed(0)}s | ${cost} |`);
  }
  for (const report of reports) {
    lines.push('', `## ${report.id} — ${report.title}: ${report.verdict.toUpperCase()}${report.mandatory ? ' (mandatory)' : ' (optional)'}`);
    if (report.skippedReason !== undefined) lines.push(`Skipped: ${report.skippedReason}`);
    if (report.error !== undefined) lines.push('', 'Error:', '```', report.error, '```');
    for (const check of report.checks) {
      lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
      for (const line of check.evidence) lines.push(`    - ${line}`);
    }
    if (report.evidence.length > 0) {
      lines.push('', 'Evidence:');
      for (const line of report.evidence) lines.push(`    ${line}`);
    }
    if (report.usageByRole.size > 0) {
      lines.push('', 'Usage:');
      for (const [role, usage] of report.usageByRole) lines.push(`- ${role}: ${formatUsage(usage)}`);
      addUsage(total, report.totalUsage());
    }
  }
  lines.push('', `Total usage: ${formatUsage(total)}`);
  return `${lines.join('\n')}\n`;
}
