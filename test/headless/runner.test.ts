import { describe, expect, it } from 'vitest';

import { formatElapsed, HEADLESS_EXIT, renderPlan, runHeadless } from '../../src/headless/runner.ts';
import type { HeadlessSnapshot } from '../../src/headless/state.ts';
import { feature, milestone, objective, type Json } from './harness.ts';
import { runOptions, snapshot, stubRun, type StateScript, type StubPi } from './stubs.ts';

const OBJECTIVE_COMMAND = '/tower objective --headless @/work/objective.md';
const FEATURES = [feature('M1', 'MS1'), feature('M2', 'MS1'), feature('M3', 'MS2')];

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/^\[pi-tower \+[0-9hms]+\] /, ''));
}

function stage(status: string, ms1: string, ms2: string, extra: Json = {}): Json {
  return objective(status, { milestones: [milestone('MS1', ms1, 1), milestone('MS2', ms2, 2)], ...extra });
}

function merged(...ids: string[]): Json[] {
  return FEATURES.map((item) => (ids.includes(String(item.id)) ? { ...item, status: 'merged' } : item));
}

function towerOn(pi: StubPi, state: StateScript, baseline: HeadlessSnapshot = snapshot(undefined), ...after: (HeadlessSnapshot | Error)[]): void {
  pi.reactions['/tower on'] = {
    notices: [{ level: 'info', text: 'Tower mode: ON' }],
    effect: () => {
      state.set(baseline);
      state.push(...after);
    },
  };
}

function drafts(pi: StubPi, state: StateScript, ...after: HeadlessSnapshot[]): void {
  pi.reactions['/tower objective'] = {
    effect: () => state.push(snapshot(undefined), snapshot(stage('planning', 'pending', 'pending')), snapshot(stage('awaiting-approval', 'pending', 'pending'), FEATURES), ...after),
  };
}

function executes(pi: StubPi, state: StateScript): void {
  pi.reactions['/tower approve'] = {
    effect: () =>
      state.push(
        snapshot(stage('executing', 'active', 'pending'), FEATURES),
        snapshot(stage('executing', 'active', 'pending'), merged('M1')),
        snapshot(stage('executing', 'validating', 'pending'), merged('M1', 'M2')),
        snapshot(stage('executing', 'passed', 'active'), merged('M1', 'M2')),
        snapshot(stage('completed', 'passed', 'passed'), merged('M1', 'M2', 'M3')),
      ),
  };
}

describe('runHeadless', () => {
  it('drives /tower on → objective → auto-approve → completion with a progress line per status or milestone change', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      executes(pi, state);
    });
    const code = await runHeadless(runOptions({ autoApprove: true, piArgs: ['--model', 'a/b'] }), run.deps);
    expect(code).toBe(HEADLESS_EXIT.completed);
    const pi = run.pi();
    expect(pi.options).toEqual({ piBin: 'pi', cwd: '/work/repo', args: ['--model', 'a/b'] });
    expect(pi.commands).toEqual(['/tower on', OBJECTIVE_COMMAND, '/tower approve']);
    const plan = renderPlan(snapshot(stage('awaiting-approval', 'pending', 'pending')).objective!, snapshot(undefined, FEATURES).features);
    expect(plain(run.info)).toEqual([
      'started pi (pi --mode rpc) in /work/repo',
      '> /tower on',
      'pi: Tower mode: ON',
      `> ${OBJECTIVE_COMMAND}`,
      'objective handed to the orchestrator: /work/objective.md',
      'waiting for the orchestrator to draft the objective',
      'O1 planning — MS1 pending · MS2 pending',
      'O1 awaiting-approval — MS1 pending · MS2 pending — features 0/3 done',
      plan,
      '> /tower approve',
      'auto-approved the plan of O1 (--auto-approve)',
      'O1 executing — MS1 active · MS2 pending — features 0/3 done',
      'O1 executing — MS1 validating · MS2 pending — features 2/3 done',
      'O1 executing — MS1 passed · MS2 active — features 2/3 done',
      'O1 completed — MS1 passed · MS2 passed — features 3/3 done',
      'objective O1 "Ship the widget" completed',
    ]);
    expect(run.errors).toEqual([]);
    expect(pi.closed).toBe(true);
    expect(pi.terminated).toBe(false);
    expect(run.signalHandlers()).toBe(0);
  });

  it('renders the plan with goal, definition of done, milestones, features, notes and the run estimate', () => {
    const plan = renderPlan(snapshot(stage('awaiting-approval', 'pending', 'pending')).objective!, snapshot(undefined, FEATURES).features);
    expect(plan.split('\n')).toEqual([
      'Plan for O1 "Ship the widget" (awaiting-approval):',
      '  goal: Build the widget end to end',
      '  definition of done:',
      '    - the widget renders',
      '    - npm test passes',
      '  acceptance commands:',
      '    - npm test',
      '  milestones:',
      '    MS1 MS1 title — validation: scrutiny, user-testing',
      '      - M1 M1 feature',
      '      - M2 M2 feature',
      '    MS2 MS2 title — validation: scrutiny, user-testing, commands (npm test)',
      '      - M3 M3 feature',
      '  notes:',
      '    - assumed: Node 22 or newer',
      '  estimated runs: 7 (features + 2 × milestones)',
    ]);
  });

  it('prints the plan and exits 3 when the plan needs approval and --auto-approve is off', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      executes(pi, state);
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.approval);
    expect(run.pi().commands).toEqual(['/tower on', OBJECTIVE_COMMAND]);
    expect(run.info.some((line) => line.startsWith('Plan for O1 "Ship the widget" (awaiting-approval):'))).toBe(true);
    expect(plain(run.errors)).toEqual([
      'objective O1 needs approval — re-run with --auto-approve to approve and continue it, or run /tower approve in pi',
    ]);
    expect(run.pi().closed).toBe(true);
  });

  it('approves again when a contract change sends the objective back to awaiting-approval', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      let approvals = 0;
      pi.reactions['/tower approve'] = {
        effect: () => {
          approvals += 1;
          if (approvals === 1) {
            state.push(snapshot(stage('executing', 'active', 'pending')), snapshot(stage('awaiting-approval', 'active', 'pending', { approvalReason: 'contract-changed' })));
          } else {
            state.push(snapshot(stage('completed', 'passed', 'passed')));
          }
        },
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.completed);
    expect(run.pi().commands).toEqual(['/tower on', OBJECTIVE_COMMAND, '/tower approve', '/tower approve']);
    expect(run.info.some((line) => line.includes('approval reason: contract-changed'))).toBe(true);
  });

  it('exits 1 when the objective is blocked', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve'] = {
        effect: () => state.push(snapshot(stage('executing', 'active', 'pending')), snapshot(stage('blocked', 'blocked', 'pending', { blockedReason: 'MS1 failed scrutiny 3 times' }))),
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(plain(run.info)).toContain('O1 blocked — MS1 blocked · MS2 pending');
    expect(plain(run.errors)).toEqual(['objective O1 is blocked: MS1 failed scrutiny 3 times']);
  });

  it('exits 1 with a /tower resume hint when the objective is paused', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve'] = { effect: () => state.push(snapshot(stage('paused', 'active', 'pending', { pausedReason: 'maxCostUsd 20 reached' }))) };
    });
    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(plain(run.errors)).toEqual([
      'objective O1 is paused: maxCostUsd 20 reached — resume it with /tower resume in pi, then re-run pi-tower run to follow it',
    ]);
  });

  it('exits 2 when --timeout elapses', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state, snapshot(stage('executing', 'active', 'pending')));
      pi.reactions['/tower approve'] = { effect: () => state.push(snapshot(stage('executing', 'active', 'pending'))) };
    });
    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 5000 }), run.deps)).toBe(HEADLESS_EXIT.timeout);
    expect(run.clock.now()).toBe(5000);
    expect(plain(run.errors)).toEqual(['timed out after 5000ms (objective O1 was executing)']);
    expect(run.pi().closed).toBe(true);
  });

  it('exits 1 with the stderr tail when pi dies after the run started', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve'] = { effect: () => state.push(snapshot(stage('executing', 'active', 'pending'))) };
      state.onRead = (reads) => {
        if (reads === 7) pi.die(1, 'fatal: heap out of memory\n');
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(plain(run.errors)).toEqual([
      'pi exited (exited with code 1) before objective O1 finished (it was executing)\npi stderr (last lines):\n  fatal: heap out of memory',
    ]);
  });

  it('exits 1 when pi dies before the orchestrator drafted the objective', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      pi.reactions['/tower objective'] = { effect: () => pi.die(7) };
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(plain(run.errors)).toEqual(['pi exited (exited with code 7) before the objective was drafted']);
  });

  it.each([
    ['SIGINT', HEADLESS_EXIT.sigint],
    ['SIGTERM', HEADLESS_EXIT.sigterm],
  ] as const)('stops pi and exits %s → %i on a signal', async (signal, expected) => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve'] = { effect: () => state.push(snapshot(stage('executing', 'active', 'pending'))) };
      state.onRead = (reads) => {
        if (reads === 8) run.signal(signal);
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(expected);
    expect(run.pi().terminated).toBe(true);
    expect(run.pi().closed).toBe(false);
    expect(plain(run.errors)).toEqual([`received ${signal} — stopping pi`, `interrupted by ${signal}; pi was stopped (objective O1 was executing)`]);
    expect(run.signalHandlers()).toBe(0);
  });

  it('kills pi outright on a second signal', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('executing', 'active', 'pending')));
      pi.terminate = async () => {
        pi.terminated = true;
        run.signal('SIGINT');
        pi.die(137);
        return pi.exit;
      };
      state.onRead = (reads) => {
        if (reads === 3) run.signal('SIGINT');
      };
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.sigint);
    expect(run.pi().killed).toEqual(['SIGKILL']);
    expect(plain(run.errors)).toContain('received SIGINT again — killing pi');
  });

  describe('startup errors exit 4', () => {
    it('when pi cannot be created', async () => {
      const run = stubRun(() => undefined, {
        createPi: () => {
          throw new Error('spawn EACCES');
        },
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(plain(run.errors)).toEqual(['could not start pi (pi): spawn EACCES']);
    });

    it('when pi is missing or dies during startup', async () => {
      const run = stubRun((pi) => {
        pi.die(127, 'pi: command not found\n');
        pi.exit = { code: null, signal: null, reason: 'spawn pi ENOENT' };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(plain(run.errors)).toEqual([
        'pi did not start (pi): pi is gone (spawn pi ENOENT) — is pi installed? Point --pi at the pi executable\npi stderr (last lines):\n  pi: command not found',
      ]);
    });

    it('when get_state fails', async () => {
      const run = stubRun((pi) => {
        pi.getState = { type: 'response', command: 'get_state', success: false, error: 'No API key found for fake' };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(plain(run.errors)).toEqual(['pi did not start: No API key found for fake']);
    });

    it('when the pi-tower extension is not loaded', async () => {
      const run = stubRun(() => undefined);
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(run.pi().commands).toEqual(['/tower on']);
      const [message] = plain(run.errors);
      expect(message).toMatch(/^pi did not run \/tower on as a pi-tower command \(the prompt was started\) — is the pi-tower extension loaded\? Install it as a pi package or pass -- -e \S+[\\/]src[\\/]index\.ts$/);
    });

    it('when /tower on reports an error', async () => {
      const run = stubRun((pi) => {
        pi.reactions['/tower on'] = { notices: [{ level: 'error', text: 'Tower mode could not be enabled — not a git repository.' }] };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(plain(run.errors)).toEqual(['/tower on failed: Tower mode could not be enabled — not a git repository.']);
    });

    it('when pi rejects the objective command', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state);
        pi.reactions['/tower objective'] = { success: false, error: 'No model selected' };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(plain(run.errors)).toEqual([`pi rejected ${OBJECTIVE_COMMAND}: No model selected`]);
      expect(run.pi().closed).toBe(true);
    });

    it('when the timeout elapses during startup it is still a timeout', async () => {
      const run = stubRun((pi) => {
        pi.send = () => new Promise(() => undefined);
      });
      expect(await runHeadless(runOptions({ timeoutMs: 1000 }), run.deps)).toBe(HEADLESS_EXIT.timeout);
      expect(plain(run.errors)).toEqual(['timed out after 1000ms']);
    });
  });

  describe('an objective that is already open at start', () => {
    it('is adopted at awaiting-approval without re-sending the objective file', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('awaiting-approval', 'pending', 'pending'), FEATURES));
        executes(pi, state);
      });
      expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.completed);
      expect(run.pi().commands).toEqual(['/tower on', '/tower approve']);
      expect(plain(run.info)).toContain('continuing existing objective O1 "Ship the widget" (status awaiting-approval) — the -f file is not re-sent');
    });

    it('is followed while executing', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('executing', 'active', 'pending')), snapshot(stage('executing', 'active', 'pending')), snapshot(stage('completed', 'passed', 'passed')));
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.completed);
      expect(run.pi().commands).toEqual(['/tower on']);
    });

    it('exits 1 at once when it is paused, never resuming it', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('paused', 'active', 'pending', { pausedReason: 'paused by the human' })));
      });
      expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
      expect(run.pi().commands).toEqual(['/tower on']);
      expect(plain(run.errors)[0]).toContain('/tower resume');
    });

    it('is re-planned when it is still in planning', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('planning', 'pending', 'pending')));
        pi.reactions['/tower objective'] = { effect: () => state.push(snapshot(stage('planning', 'pending', 'pending')), snapshot(stage('awaiting-approval', 'pending', 'pending'))) };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.approval);
      expect(run.pi().commands).toEqual(['/tower on', OBJECTIVE_COMMAND]);
    });
  });

  it.each(['completed', 'blocked'])('never reports a %s objective left over from an earlier run as this run’s result', async (status) => {
    const leftover = snapshot(stage(status, 'passed', 'passed'));
    const fresh = objective('awaiting-approval', { id: 'O2', title: 'Next goal', createdAt: '2026-11-09T05:00:00.000Z' });
    const run = stubRun((pi, state) => {
      towerOn(pi, state, leftover);
      pi.reactions['/tower objective'] = { effect: () => state.push(leftover, leftover, snapshot(fresh)) };
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.approval);
    expect(run.pi().commands).toEqual(['/tower on', OBJECTIVE_COMMAND]);
    expect(plain(run.info).filter((line) => line.startsWith('O'))).toEqual(['O2 awaiting-approval — MS1 pending · MS2 pending']);
    expect(plain(run.errors)[0]).toContain('objective O2 needs approval');
  });

  it('cancels pi dialogs, reports warnings and extension errors, and retries an unreadable state file', async () => {
    const run = stubRun((pi, state) => {
      towerOn(
        pi,
        state,
        snapshot(stage('executing', 'active', 'pending')),
        snapshot(stage('executing', 'active', 'pending')),
        new Error('Unexpected end of JSON input'),
        snapshot(stage('executing', 'active', 'pending')),
        snapshot(stage('completed', 'passed', 'passed')),
      );
      state.onRead = (reads) => {
        if (reads !== 2) return;
        pi.emit({ type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: 'Create branch "x"?' });
        pi.emit({ type: 'extension_ui_request', id: 'n-1', method: 'notify', message: 'quiet info', notifyType: 'info' });
        pi.emit({ type: 'extension_ui_request', id: 'n-2', method: 'notify', message: 'worker M1 hit a rate limit', notifyType: 'warning' });
        pi.emit({ type: 'extension_error', extensionPath: '/x.ts', event: 'tool_call', error: 'boom' });
      };
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.completed);
    expect(run.pi().responses).toEqual([{ id: 'dialog-1', response: { cancelled: true } }]);
    expect(plain(run.info)).toContain('cancelled a pi confirm dialog nobody can answer headless: Create branch "x"?');
    expect(plain(run.errors)).toEqual([
      'pi warning: worker M1 hit a rate limit',
      'pi extension error: boom',
      'cannot read .tower/comms/state.json (will retry): Unexpected end of JSON input',
    ]);
  });

  it('exits 1 when the auto-approval is refused', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve'] = { notices: [{ level: 'error', text: 'Objective O1 is not awaiting approval.' }] };
    });
    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(plain(run.errors)).toEqual(['/tower approve failed: Objective O1 is not awaiting approval.']);
  });
});

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(65_000)).toBe('1m05s');
    expect(formatElapsed(2 * 3_600_000 + 3 * 60_000)).toBe('2h03m');
  });
});
