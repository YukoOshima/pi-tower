import { afterEach, describe, expect, it } from 'vitest';

import { PiRpcClient, PiRpcError, type PiEvent } from '../../src/headless/rpc.ts';
import { createWorld, isAlive, processGroup, waitDead, type FakeWorld, type Json } from './harness.ts';

const worlds: FakeWorld[] = [];
const clients: PiRpcClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.terminate(1000);
  for (const world of worlds.splice(0)) world.cleanup();
});

function start(scenario: Parameters<FakeWorld['scenario']>[0], extra: readonly string[] = []): { world: FakeWorld; pi: PiRpcClient } {
  const world = createWorld();
  worlds.push(world);
  const pi = new PiRpcClient({ piBin: world.piBin, cwd: world.repo, args: [...world.scenario(scenario), ...extra] });
  clients.push(pi);
  return { world, pi };
}

describe('PiRpcClient', () => {
  it('spawns pi --mode rpc with the extra args in the cwd and correlates responses by id', async () => {
    const { world, pi } = start({}, ['--model', 'a/b']);
    const [first, second] = await Promise.all([pi.send({ type: 'get_state' }), pi.send({ type: 'bogus' })]);
    expect(first).toMatchObject({ type: 'response', command: 'get_state', success: true });
    expect(second).toMatchObject({ type: 'response', success: false, error: 'Unknown command: bogus' });
    expect(first.id).not.toBe(second.id);
    const started = world.log().find((entry) => entry.kind === 'start');
    expect(started?.argv).toEqual(['--mode', 'rpc', '--scenario', `${world.dir}/scenario.json`, '--log', world.logFile, '--model', 'a/b']);
    expect(started?.cwd).toBe(world.repo);
  });

  it('runs a slash command and collects the notices pi emitted for it', async () => {
    const { pi } = start({ commands: [{ match: '/tower on', before: [{ notify: { text: 'Tower mode: ON' } }, { notify: { level: 'warning', text: 'careful' } }] }] });
    expect(await pi.command('/tower on')).toEqual({
      success: true,
      disposition: 'handled',
      error: undefined,
      notices: [
        { level: 'info', text: 'Tower mode: ON' },
        { level: 'warning', text: 'careful' },
      ],
    });
    expect(await pi.command('/tower nope')).toMatchObject({ success: true, disposition: 'started' });
  });

  it('reports a rejected command', async () => {
    const { pi } = start({ commands: [{ match: '/x', error: 'No model selected' }] });
    expect(await pi.command('/x')).toEqual({ success: false, disposition: undefined, error: 'No model selected', notices: [] });
  });

  it('streams events to listeners and tracks the run until it is idle', async () => {
    const { pi } = start({});
    const seen: string[] = [];
    pi.onEvent((event) => seen.push(event.type));
    const settled = pi.waitFor((event) => event.type === 'agent_settled', 5000, 'settle');
    await pi.command('hello model');
    await settled;
    await pi.waitIdle(5000, 50);
    expect(pi.running).toBe(false);
    expect(seen).toEqual(['agent_start', 'agent_settled']);
  });

  it('answers extension dialogs through respond()', async () => {
    const { world, pi } = start({ commands: [{ match: '/ask', after: [{ dialog: { method: 'confirm', title: 'Create branch?' } }] }] });
    const dialog = pi.waitFor((event) => event.type === 'extension_ui_request' && event.method === 'confirm', 5000, 'dialog');
    await pi.command('/ask');
    const request: PiEvent = await dialog;
    pi.respond(String(request.id), { cancelled: true });
    await pi.close(5000);
    const answer = world.log().find((entry) => entry.kind === 'ui-response');
    expect(answer?.record).toEqual({ type: 'extension_ui_response', id: request.id, cancelled: true });
  });

  it('captures stderr and tracks the exit of a crashing pi', async () => {
    const { pi } = start({ stderr: 'boom: bad config\n', commands: [{ match: '/crash', after: [{ delayMs: 20, exit: 3 }] }] });
    const waiting = pi.waitFor(() => false, 5000, 'nothing');
    await pi.command('/crash');
    const exit = await pi.exited;
    expect(exit).toEqual({ code: 3, signal: null, reason: 'exited with code 3' });
    expect(pi.exit).toEqual(exit);
    expect(pi.stderrTail()).toBe('boom: bad config');
    await expect(waiting).rejects.toThrow('pi is gone (exited with code 3) while waiting for nothing');
    await expect(pi.send({ type: 'get_state' })).rejects.toBeInstanceOf(PiRpcError);
  });

  it('rejects pending requests when pi dies before answering', async () => {
    const { pi } = start({ silent: ['get_state'], commands: [{ match: '/crash', after: [{ delayMs: 50, exit: 1 }] }] });
    const pending = pi.send({ type: 'get_state' });
    await pi.command('/crash');
    await expect(pending).rejects.toThrow('pi is gone (exited with code 1)');
  });

  it('times out a request pi never answers', async () => {
    const { pi } = start({ silent: ['get_state'] });
    await expect(pi.send({ type: 'get_state' }, 100)).rejects.toThrow('timeout after 100ms waiting for the get_state response');
  });

  it('reports a pi binary that cannot be spawned', async () => {
    const pi = new PiRpcClient({ piBin: '/nonexistent/pi-binary', cwd: process.cwd() });
    clients.push(pi);
    await expect(pi.send({ type: 'get_state' })).rejects.toThrow(/ENOENT/);
    expect(pi.exit?.reason).toMatch(/ENOENT/);
  });

  it('closes pi gracefully by ending stdin', async () => {
    const { world, pi } = start({});
    await pi.send({ type: 'get_state' });
    expect(await pi.close(5000)).toEqual({ code: 0, signal: null, reason: 'exited with code 0' });
    expect(world.log().map((entry: Json) => entry.kind)).toContain('stdin-end');
  });

  it('terminates with SIGTERM and escalates to SIGKILL when pi ignores it', async () => {
    const polite = start({});
    await polite.pi.send({ type: 'get_state' });
    expect(await polite.pi.terminate(5000)).toMatchObject({ code: 143 });
    const stubborn = start({ ignoreSigterm: true });
    await stubborn.pi.send({ type: 'get_state' });
    expect(await stubborn.pi.terminate(200)).toMatchObject({ code: null, signal: 'SIGKILL' });
    expect(stubborn.world.log().some((entry) => entry.kind === 'signal')).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || processGroup(process.pid) === undefined)('starts pi as the leader of its own process group', async () => {
    const { pi } = start({});
    await pi.send({ type: 'get_state' });
    const pid = Number(pi.pid);
    expect(processGroup(pid)).toBe(pid);
    expect(processGroup(process.pid)).not.toBe(pid);
  });

  it.skipIf(process.platform === 'win32')('takes pi’s whole process group down when SIGTERM is ignored and SIGKILL follows', async () => {
    const { world, pi } = start({ ignoreSigterm: true, spawnChild: true });
    await pi.send({ type: 'get_state' });
    const child = Number(world.log().find((entry) => entry.kind === 'child')?.pid);
    expect(isAlive(child)).toBe(true);
    expect(await pi.terminate(200)).toMatchObject({ signal: 'SIGKILL' });
    expect(await waitDead(child)).toBe(true);
  });
});
