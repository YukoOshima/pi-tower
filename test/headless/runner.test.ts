import { describe, expect, it } from 'vitest';

import type { PiEvent } from '../../src/headless/rpc.ts';
import { formatElapsed, HEADLESS_EXIT, renderPlan, runHeadless } from '../../src/headless/runner.ts';
import type { HeadlessSnapshot } from '../../src/headless/state.ts';
import { TOWER_HUMAN_APPROVAL_MARKER } from '../../src/protocol/objective.ts';
import { feature, milestone, objective, type Json } from './harness.ts';
import {
  MODEL_LINES,
  MODEL_PROBLEMS,
  PROBLEM_MODEL_LINES,
  modelsReplyWithProblems,
  runOptions,
  snapshot,
  stubRun,
  type StateScript,
  type StubPi,
  type StubReaction,
} from './stubs.ts';

const OBJECTIVE_COMMAND = '/tower objective --headless @/work/objective.md';
const FEATURES = [feature('M1', 'MS1'), feature('M2', 'MS1'), feature('M3', 'MS2')];

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/^\[pi-tower \+[0-9hms]+\] /, ''));
}

function stage(status: string, ms1: string, ms2: string, extra: Json = {}): Json {
  return objective(status, { milestones: [milestone('MS1', ms1, 1), milestone('MS2', ms2, 2)], ...extra });
}

function commandError(error: string): PiEvent {
  return { type: 'extension_error', extensionPath: 'command:tower', event: 'command', error };
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
  pi.reactions['/tower approve --auto'] = {
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
    expect(pi.commands).toEqual(['/tower on', '/tower models', OBJECTIVE_COMMAND, '/tower approve --auto']);
    const plan = renderPlan(snapshot(stage('awaiting-approval', 'pending', 'pending')).objective!, snapshot(undefined, FEATURES).features);
    expect(plain(run.info)).toEqual([
      'started pi (pi --mode rpc) in /work/repo',
      '> /tower on',
      'pi: Tower mode: ON',
      '> /tower models',
      ...MODEL_LINES,
      `> ${OBJECTIVE_COMMAND}`,
      'objective handed to the orchestrator: /work/objective.md',
      'waiting for the orchestrator to draft the objective',
      'O1 planning — MS1 pending · MS2 pending',
      'O1 awaiting-approval — MS1 pending · MS2 pending — features 0/3 done',
      plan,
      '> /tower approve --auto',
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
    expect(run.pi().commands).toEqual(['/tower on', '/tower models', OBJECTIVE_COMMAND]);
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
      pi.reactions['/tower approve --auto'] = {
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
    expect(run.pi().commands).toEqual(['/tower on', '/tower models', OBJECTIVE_COMMAND, '/tower approve --auto', '/tower approve --auto']);
    expect(run.info.some((line) => line.includes('approval reason: contract-changed'))).toBe(true);
  });

  it('re-reads the state right after approving, so a plan sent back before the next poll is approved again', async () => {
    let flipAt: number | undefined;
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      let approvals = 0;
      pi.reactions['/tower approve --auto'] = {
        effect: () => {
          approvals += 1;
          if (approvals > 1) {
            state.set(snapshot(stage('completed', 'passed', 'passed')));
            return;
          }
          state.set(snapshot(stage('executing', 'active', 'pending')));
          flipAt = run.clock.now();
        },
      };
      state.onRead = () => {
        if (flipAt === undefined || run.clock.now() <= flipAt) return;
        flipAt = undefined;
        state.set(snapshot(stage('awaiting-approval', 'active', 'pending', { approvalReason: 'contract-changed' })));
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.completed);
    expect(run.pi().commands.filter((command) => command.startsWith('/tower approve --auto'))).toHaveLength(2);
    expect(plain(run.info)).toContain('O1 executing — MS1 active · MS2 pending');
  });

  it('approves again when the store sends the plan back (approvedAt deleted) before the immediate re-read', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      let approvals = 0;
      pi.reactions['/tower approve --auto'] = {
        effect: () => {
          approvals += 1;
          state.set(
            approvals === 1
              ? snapshot(stage('awaiting-approval', 'active', 'pending', { approvalReason: 'contract-changed' }))
              : snapshot(stage('completed', 'passed', 'passed', { approvedAt: '2026-11-09T02:00:00.000Z', approvedBy: 'auto' })),
          );
        },
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.completed);
    expect(run.pi().commands.filter((command) => command === '/tower approve --auto')).toHaveLength(2);
    expect(run.info.filter((line) => line.startsWith('Plan for O1'))).toHaveLength(2);
    expect(run.info.some((line) => line.includes('approval reason: contract-changed'))).toBe(true);
  });

  it.each(['sent back with approvedAt deleted, as the store does', 'sent back with a new approvedAt', 'executing seen first, then sent back'] as const)(
    'regression (review r2 reapprove-race): re-approves a plan %s',
    async (variant) => {
      let approvals = 0;
      const run = stubRun((pi, state) => {
        pi.reactions['/tower on'] = { notices: [{ level: 'info', text: 'Tower mode: ON' }], effect: () => state.set(snapshot(undefined)) };
        pi.reactions['/tower objective'] = { effect: () => state.push(snapshot(stage('awaiting-approval', 'pending', 'pending'))) };
        pi.reactions['/tower approve --auto'] = {
          effect: () => {
            approvals += 1;
            if (approvals > 1) {
              state.set(snapshot(stage('completed', 'passed', 'passed', { approvedAt: '2026-11-09T02:00:00.000Z' })));
              return;
            }
            const executing = snapshot(stage('executing', 'active', 'pending', { approvedAt: '2026-11-09T01:00:00.000Z', approvedBy: 'auto' }));
            const sentBack = stage('awaiting-approval', 'active', 'pending', { approvalReason: 'contract-changed' });
            if (variant === 'sent back with approvedAt deleted, as the store does') state.set(snapshot(sentBack));
            else if (variant === 'sent back with a new approvedAt') state.set(snapshot({ ...sentBack, approvedAt: '2026-11-09T01:00:00.000Z' }));
            else {
              state.set(executing);
              state.push(executing, snapshot(sentBack));
            }
          },
        };
      });
      expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.completed);
      expect(approvals).toBe(2);
    },
  );

  it('exits 1 with the refusal when the extension refuses a second approval, instead of waiting', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve --auto'] = {
        effect: (stub) => {
          stub.reactions['/tower approve --auto'] = { notices: [{ level: 'error', text: 'Only an objective awaiting approval can be approved.' }] };
        },
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(run.pi().commands.filter((command) => command === '/tower approve --auto')).toHaveLength(2);
    expect(plain(run.errors)).toEqual(['/tower approve --auto failed: Only an objective awaiting approval can be approved.']);
    expect(run.clock.now()).toBeLessThan(60_000);
  });

  it('never spins when approvals are accepted but the plan stays awaiting approval: at most two approvals per poll until --timeout', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve --auto'] = {};
    });
    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 5000 }), run.deps)).toBe(HEADLESS_EXIT.timeout);
    expect(run.pi().commands.filter((command) => command === '/tower approve --auto')).toHaveLength(6);
  });

  it('exits 1 when the objective is blocked', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve --auto'] = {
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
      pi.reactions['/tower approve --auto'] = { effect: () => state.push(snapshot(stage('paused', 'active', 'pending', { pausedReason: 'maxCostUsd 20 reached' }))) };
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
      pi.reactions['/tower approve --auto'] = { effect: () => state.push(snapshot(stage('executing', 'active', 'pending'))) };
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
      pi.reactions['/tower approve --auto'] = { effect: () => state.push(snapshot(stage('executing', 'active', 'pending'))) };
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
      pi.reactions['/tower approve --auto'] = { effect: () => state.push(snapshot(stage('executing', 'active', 'pending'))) };
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

  it('sends no further approve once a SIGINT landed during the immediate re-read', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      let approved = false;
      pi.reactions['/tower approve --auto'] = {
        effect: () => {
          approved = true;
          state.set(snapshot(stage('awaiting-approval', 'active', 'pending', { approvalReason: 'contract-changed' })));
        },
      };
      pi.terminate = async () => {
        pi.terminated = true;
        return undefined;
      };
      state.onRead = () => {
        if (approved && !pi.terminated) run.signal('SIGINT');
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.sigint);
    expect(run.pi().commands.filter((command) => command === '/tower approve --auto')).toHaveLength(1);
    expect(run.pi().terminated).toBe(true);
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

  describe('role models', () => {
    it('passes each role model to pi as --tower-<role>-model after the extra pi args', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state);
        drafts(pi, state);
      });
      const models = { validator: 'google/gemini-2.5-pro:low', orchestrator: 'anthropic/claude-opus-4-5:high', worker: 'openai/gpt-5.1-codex' };
      expect(await runHeadless(runOptions({ piArgs: ['-e', 'ext.ts', '--tower-worker-model', 'old/model'], models }), run.deps)).toBe(HEADLESS_EXIT.approval);
      expect(run.pi().options).toEqual({
        piBin: 'pi',
        cwd: '/work/repo',
        args: [
          '-e',
          'ext.ts',
          '--tower-worker-model',
          'old/model',
          '--tower-orchestrator-model=anthropic/claude-opus-4-5:high',
          '--tower-worker-model=openai/gpt-5.1-codex',
          '--tower-validator-model=google/gemini-2.5-pro:low',
        ],
      });
    });

    it('prints the role models before continuing an objective that is already open', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('executing', 'active', 'pending')), snapshot(stage('executing', 'active', 'pending')), snapshot(stage('completed', 'passed', 'passed')));
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.completed);
      expect(run.pi().commands).toEqual(['/tower on', '/tower models']);
      const lines = plain(run.info);
      const continuing = lines.findIndex((line) => line.startsWith('continuing existing objective O1'));
      expect(lines.slice(continuing - 5, continuing)).toEqual(['> /tower models', ...MODEL_LINES]);
    });

    it.each<[string, StubReaction, string]>([
      [
        'pi answers with an error',
        { notices: [{ level: 'error', text: 'Tower model configuration is not available in this build.' }] },
        '/tower models failed: Tower model configuration is not available in this build.',
      ],
      ['pi rejects the command', { success: false, error: 'pi is busy' }, 'pi rejected /tower models: pi is busy'],
      ['pi does not run it as a command', { disposition: 'started' }, 'pi did not run /tower models as a pi-tower command (the prompt was started)'],
      [
        'the reply has no model table',
        { notices: [{ level: 'info', text: 'Tower models\nThe tower model configuration could not be loaded:\n/x/tower.json: Unexpected token' }] },
        'the /tower models reply has no model table: Tower models The tower model configuration could not be loaded: /x/tower.json: Unexpected token',
      ],
      ['pi gives no reply', { notices: [] }, '/tower models gave no reply'],
      [
        'the command fails',
        {
          effect: () => {
            throw new Error('timeout after 60000ms waiting for the prompt response');
          },
        },
        '/tower models failed: timeout after 60000ms waiting for the prompt response',
      ],
    ])('says in one line that the role models are unavailable when %s, then hands over the objective', async (_label, reaction, reason) => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state);
        drafts(pi, state);
        executes(pi, state);
        pi.reactions['/tower models'] = reaction;
      });
      expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.completed);
      expect(run.pi().commands).toEqual(['/tower on', '/tower models', OBJECTIVE_COMMAND, '/tower approve --auto']);
      const lines = plain(run.info);
      expect(lines.slice(lines.indexOf('> /tower models'), lines.indexOf(`> ${OBJECTIVE_COMMAND}`))).toEqual([
        '> /tower models',
        `role models unavailable (${reason}) — continuing`,
      ]);
      expect(run.errors).toEqual([]);
    });

    it('warns on stderr about each problem the /tower models reply lists, right after the role lines, and still hands over the objective', async () => {
      const reply = await modelsReplyWithProblems();
      const output: string[] = [];
      const record = (stream: string) => (line: string): void => {
        output.push(`${stream} ${plain([line])[0] ?? ''}`);
      };
      const run = stubRun(
        (pi, state) => {
          towerOn(pi, state);
          drafts(pi, state);
          executes(pi, state);
          pi.reactions['/tower models'] = { notices: [{ level: 'info', text: reply }] };
        },
        { output: { info: record('stdout'), error: record('stderr') } },
      );
      expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.completed);
      expect(run.pi().commands).toEqual(['/tower on', '/tower models', OBJECTIVE_COMMAND, '/tower approve --auto']);
      expect(output.slice(output.indexOf('stdout > /tower models'), output.indexOf(`stdout > ${OBJECTIVE_COMMAND}`))).toEqual([
        'stdout > /tower models',
        ...PROBLEM_MODEL_LINES.map((line) => `stdout ${line}`),
        ...MODEL_PROBLEMS.map((problem) => `stderr model warning: ${problem}`),
      ]);
      expect(output.filter((line) => line.startsWith('stderr '))).toEqual(MODEL_PROBLEMS.map((problem) => `stderr model warning: ${problem}`));
      expect(output.at(-1)).toBe('stdout objective O1 "Ship the widget" completed');
    });

    it('reports a warning that comes with the models reply and still prints the role models', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state);
        drafts(pi, state);
        const models = pi.reactions['/tower models'];
        pi.reactions['/tower models'] = { notices: [{ level: 'warning', text: 'the project tower.json is ignored until you trust the project' }, ...(models?.notices ?? [])] };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.approval);
      const lines = plain(run.info);
      expect(lines.slice(lines.indexOf('> /tower models') + 1, lines.indexOf(`> ${OBJECTIVE_COMMAND}`))).toEqual(MODEL_LINES);
      expect(plain(run.errors)[0]).toBe('pi warning: the project tower.json is ignored until you trust the project');
    });

    it('never hands over the objective when a signal arrives while /tower models runs', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state);
        drafts(pi, state);
        const models = pi.reactions['/tower models'];
        pi.reactions['/tower models'] = { ...models, effect: () => run.signal('SIGTERM') };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.sigterm);
      expect(run.pi().commands).toEqual(['/tower on', '/tower models']);
      expect(run.pi().terminated).toBe(true);
      expect(plain(run.errors)).toEqual(['received SIGTERM — stopping pi', 'interrupted by SIGTERM; pi was stopped']);
    });
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

    it('when pi lists no /tower extension command, before any prompt could start a model turn', async () => {
      const run = stubRun((pi) => {
        pi.getCommands = {
          type: 'response',
          command: 'get_commands',
          success: true,
          data: { commands: [{ name: 'tower', source: 'prompt' }, { name: 'skill:tower', source: 'skill' }, { name: 'review', source: 'extension' }] },
        };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(run.pi().commands).toEqual([]);
      const [message] = plain(run.errors);
      expect(message).toMatch(/^pi has no \/tower command — is the pi-tower extension loaded\? Install it as a pi package or pass -- -e \S+[\\/]src[\\/]index\.ts$/);
    });

    it('when the extension is loaded twice and pi renamed /tower', async () => {
      const run = stubRun((pi) => {
        pi.getCommands = {
          type: 'response',
          command: 'get_commands',
          success: true,
          data: { commands: [{ name: 'tower:1', source: 'extension' }, { name: 'tower:2', source: 'extension' }] },
        };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(run.pi().commands).toEqual([]);
      expect(plain(run.errors)).toEqual([
        'the pi-tower extension is loaded more than once, so pi renamed its commands to /tower:1, /tower:2 and /tower is ambiguous — load it only once (drop -e when pi-tower is also installed as a pi package)',
      ]);
    });

    it('when pi does not answer get_commands', async () => {
      const run = stubRun((pi) => {
        const send = pi.send.bind(pi);
        pi.send = async (command) => {
          if (command.type === 'get_commands') throw new Error('timeout after 60000ms waiting for the get_commands response');
          return send(command);
        };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(plain(run.errors)).toEqual(['pi did not answer get_commands: timeout after 60000ms waiting for the get_commands response']);
    });

    it('when a pi without get_commands sends /tower on to the model, caught by the fallback check', async () => {
      const run = stubRun((pi) => {
        pi.getCommands = { type: 'response', command: 'get_commands', success: false, error: 'Unknown command: get_commands' };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
      expect(run.pi().commands).toEqual(['/tower on']);
      expect(plain(run.info)).toContain('pi cannot list its commands (Unknown command: get_commands) — checking how it handles /tower on instead');
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
      expect(run.pi().commands).toEqual(['/tower on', '/tower models', '/tower approve --auto']);
      expect(plain(run.info)).toContain('continuing existing objective O1 "Ship the widget" (status awaiting-approval) — the -f file is not re-sent');
    });

    it('is followed while executing', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('executing', 'active', 'pending')), snapshot(stage('executing', 'active', 'pending')), snapshot(stage('completed', 'passed', 'passed')));
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.completed);
      expect(run.pi().commands).toEqual(['/tower on', '/tower models']);
    });

    it('exits 1 at once when it is paused, never resuming it', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('paused', 'active', 'pending', { pausedReason: 'paused by the human' })));
      });
      expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
      expect(run.pi().commands).toEqual(['/tower on', '/tower models']);
      expect(plain(run.errors)[0]).toContain('/tower resume');
    });

    it('is re-planned when it is still in planning', async () => {
      const run = stubRun((pi, state) => {
        towerOn(pi, state, snapshot(stage('planning', 'pending', 'pending')));
        pi.reactions['/tower objective'] = { effect: () => state.push(snapshot(stage('planning', 'pending', 'pending')), snapshot(stage('awaiting-approval', 'pending', 'pending'))) };
      });
      expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.approval);
      expect(run.pi().commands).toEqual(['/tower on', '/tower models', OBJECTIVE_COMMAND]);
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
    expect(run.pi().commands).toEqual(['/tower on', '/tower models', OBJECTIVE_COMMAND]);
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

  it('prints info notices of its own commands to stdout and warnings to stderr', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('completed', 'passed', 'passed')));
      pi.reactions['/tower on'] = {
        notices: [
          { level: 'info', text: 'Tower mode: ON\nmore detail' },
          { level: 'warning', text: 'the validator model falls back to the reviewer model' },
        ],
        effect: () => state.set(snapshot(stage('executing', 'active', 'pending'))),
      };
      state.onRead = (reads) => {
        if (reads === 2) state.set(snapshot(stage('completed', 'passed', 'passed')));
      };
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.completed);
    expect(plain(run.info)).toContain('pi: Tower mode: ON');
    expect(plain(run.errors)).toEqual(['pi warning: the validator model falls back to the reviewer model']);
  });

  it('exits 1 when the auto-approval is refused', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve --auto'] = { notices: [{ level: 'error', text: 'Objective O1 is not awaiting approval.' }] };
    });
    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(plain(run.errors)).toEqual(['/tower approve --auto failed: Objective O1 is not awaiting approval.']);
  });

  it('prints the plan and exits 3 when the auto-approval is refused because only a human can approve', async () => {
    const refusal = `Approval failed — objective O1 changed its contract while it was blocked or paused, so only a human can approve it — auto-approval stays refused until a human approves ${TOWER_HUMAN_APPROVAL_MARKER}`;
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('awaiting-approval', 'active', 'pending', { approvalReason: 'contract-changed' }), FEATURES));
      pi.reactions['/tower approve --auto'] = { notices: [{ level: 'error', text: refusal }] };
    });

    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.approval);

    expect(run.pi().commands).toEqual(['/tower on', '/tower models', '/tower approve --auto']);
    expect(run.info.some((line) => line.startsWith('Plan for O1 "Ship the widget" (awaiting-approval):'))).toBe(true);
    expect(run.info.some((line) => line.includes('\n  approval reason: contract-changed\n'))).toBe(true);
    expect(plain(run.errors)).toEqual([
      `pi refused /tower approve --auto: ${refusal}`,
      'objective O1 needs approval — a human must approve: run /tower approve in pi',
    ]);
    expect(run.info.some((line) => line.includes('auto-approved'))).toBe(false);
    expect(run.pi().closed).toBe(true);
  });

  it('exits 3 when the human-approval refusal arrives as a command error among other errors', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('awaiting-approval', 'active', 'pending'), FEATURES));
      pi.reactions['/tower approve --auto'] = {
        notices: [{ level: 'error', text: 'something else went wrong' }],
        effect: (stub) => {
          stub.emit(commandError(`objective O1 needs a human ${TOWER_HUMAN_APPROVAL_MARKER}`));
        },
      };
    });

    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.approval);
    expect(plain(run.errors).at(-1)).toBe('objective O1 needs approval — a human must approve: run /tower approve in pi');
  });

  it('follows the objective when the auto-approval is refused because the tower approved the plan meanwhile', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('awaiting-approval', 'pending', 'pending'), FEATURES));
      pi.reactions['/tower approve --auto'] = {
        notices: [
          {
            level: 'error',
            text: 'Approval failed — objective O1 is executing — only an objective awaiting approval can be approved; the orchestrator requests approval first',
          },
        ],
        effect: () => {
          state.push(snapshot(stage('executing', 'active', 'pending'), FEATURES), snapshot(stage('completed', 'passed', 'passed'), merged('M1', 'M2', 'M3')));
        },
      };
    });

    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.completed);

    expect(run.pi().commands).toEqual(['/tower on', '/tower models', '/tower approve --auto']);
    expect(plain(run.info)).toContain('objective O1 moved on to executing meanwhile, so pi refused /tower approve --auto — following it');
    expect(plain(run.info)).toContain('objective O1 "Ship the widget" completed');
    expect(run.info.some((line) => line.includes('auto-approved'))).toBe(false);
    expect(run.errors).toEqual([]);
  });

  it('gives the tower two polls to approve the plan itself before exiting 3, and follows the objective when it does', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('awaiting-approval', 'pending', 'pending'), FEATURES));
      state.onRead = (reads) => {
        if (reads === 3) state.push(snapshot(stage('executing', 'active', 'pending'), FEATURES), snapshot(stage('completed', 'passed', 'passed'), merged('M1', 'M2', 'M3')));
      };
    });

    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.completed);

    expect(run.pi().commands).toEqual(['/tower on', '/tower models']);
    expect(run.info.filter((line) => line.startsWith('Plan for O1'))).toHaveLength(1);
    expect(plain(run.info)).toContain('objective O1 moved on to executing while waiting for its approval — following it');
    expect(run.errors).toEqual([]);
  });

  it('exits 3 only after the plan stayed awaiting approval for two polls', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('awaiting-approval', 'pending', 'pending'), FEATURES));
    });

    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.approval);

    expect(run.state.reads).toBe(4);
    expect(run.clock.now()).toBe(2000);
    expect(run.info.filter((line) => line.startsWith('Plan for O1'))).toHaveLength(1);
    expect(plain(run.errors)).toEqual([
      'objective O1 needs approval — re-run with --auto-approve to approve and continue it, or run /tower approve in pi',
    ]);
  });

  it('keeps exit 1 for a refusal that only mentions a human without the protocol marker', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state, snapshot(stage('awaiting-approval', 'active', 'pending'), FEATURES));
      pi.reactions['/tower approve --auto'] = {
        notices: [{ level: 'error', text: 'Approval failed — only a human can approve it, says a stale build' }],
      };
    });

    expect(await runHeadless(runOptions({ autoApprove: true }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(plain(run.errors)).toEqual([
      '/tower approve --auto failed: Approval failed — only a human can approve it, says a stale build',
    ]);
  });

  it('exits 1 once when the approve handler throws, although pi answers handled', async () => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      drafts(pi, state);
      pi.reactions['/tower approve --auto'] = {
        effect: (stub) => {
          stub.emit(commandError('objective O1 cannot be approved: the first milestone MS1 has no build feature'));
        },
      };
    });
    expect(await runHeadless(runOptions({ autoApprove: true, timeoutMs: 60_000 }), run.deps)).toBe(HEADLESS_EXIT.stopped);
    expect(run.pi().commands.filter((command) => command === '/tower approve --auto')).toHaveLength(1);
    expect(plain(run.errors)).toEqual(['/tower approve --auto failed: objective O1 cannot be approved: the first milestone MS1 has no build feature']);
    expect(run.info.some((line) => line.includes('auto-approved'))).toBe(false);
  });

  it.each([
    ['/tower on', '/tower on'],
    ['/tower objective', OBJECTIVE_COMMAND],
  ])('exits 4 when the %s handler throws, although pi answers handled', async (prefix, sent) => {
    const run = stubRun((pi, state) => {
      towerOn(pi, state);
      pi.reactions[prefix] = {
        effect: (stub) => {
          stub.emit(commandError('an objective O7 is already executing — finish or block it first'));
        },
      };
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.startup);
    expect(plain(run.errors)).toEqual([`${sent} failed: an objective O7 is already executing — finish or block it first`]);
    expect(plain(run.info)).not.toContain('objective handed to the orchestrator: /work/objective.md');
  });

  it('still reports a command extension error that arrives while none of its commands is in flight', async () => {
    const run = stubRun((pi, state) => {
      towerOn(
        pi,
        state,
        snapshot(stage('executing', 'active', 'pending')),
        snapshot(stage('executing', 'active', 'pending')),
        snapshot(stage('executing', 'active', 'pending')),
        snapshot(stage('completed', 'passed', 'passed')),
      );
      state.onRead = (reads) => {
        if (reads === 2) pi.emit(commandError('a /tower command typed elsewhere failed'));
      };
    });
    expect(await runHeadless(runOptions(), run.deps)).toBe(HEADLESS_EXIT.completed);
    expect(plain(run.errors)).toEqual(['pi extension error: a /tower command typed elsewhere failed']);
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
