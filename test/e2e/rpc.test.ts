import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CANCEL_DIALOG, chooseOption, describeDialogAnswer, dialogRequestOf, PiRpc, type PiDialogRequest } from './rpc.ts';

const dirs: string[] = [];
const sessions: PiRpc[] = [];

afterEach(async () => {
  for (const rpc of sessions.splice(0)) await rpc.close(2000);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SELECT: PiDialogRequest = { id: 'ui-3', method: 'select', title: 'Mission O1 "Two commands" — plan ready (1 milestone · 2 features). Approve it?', message: undefined, options: ['Not yet — keep planning', 'Approve and start mission'] };

describe('dialogRequestOf', () => {
  it('reads the method, title, message and options of every dialog request', () => {
    expect(dialogRequestOf({ type: 'extension_ui_request', id: 'ui-3', method: 'select', title: SELECT.title, options: [...SELECT.options], timeout: undefined })).toEqual(SELECT);
    expect(dialogRequestOf({ type: 'extension_ui_request', id: 'ui-4', method: 'confirm', title: 'Sure?', message: 'This stops the agent.' })).toEqual({ id: 'ui-4', method: 'confirm', title: 'Sure?', message: 'This stops the agent.', options: [] });
    expect(dialogRequestOf({ type: 'extension_ui_request', id: 'ui-5', method: 'editor', title: 'Edit', prefill: 'x' })?.method).toBe('editor');
    expect(dialogRequestOf({ type: 'extension_ui_request', id: 'ui-6', method: 'input', title: 'Name' })?.method).toBe('input');
  });

  it('ignores fire-and-forget UI requests and other events', () => {
    expect(dialogRequestOf({ type: 'extension_ui_request', id: 'ui-1', method: 'notify', message: 'hi' })).toBeUndefined();
    expect(dialogRequestOf({ type: 'extension_ui_request', id: 'ui-2', method: 'setWidget', widgetKey: 'mission', widgetLines: ['a'] })).toBeUndefined();
    expect(dialogRequestOf({ type: 'message_end', method: 'select' })).toBeUndefined();
  });
});

describe('chooseOption', () => {
  it('answers a matching select with the option at that position', () => {
    expect(chooseOption(0)(SELECT)).toEqual({ value: 'Not yet — keep planning' });
    expect(chooseOption(1, (request) => request.title.startsWith('Mission '))(SELECT)).toEqual({ value: 'Approve and start mission' });
  });

  it('leaves other dialogs, unmatched selects and missing positions to the default', () => {
    expect(chooseOption(0)({ ...SELECT, method: 'confirm' })).toBeUndefined();
    expect(chooseOption(0, () => false)(SELECT)).toBeUndefined();
    expect(chooseOption(2)(SELECT)).toBeUndefined();
  });

  it('describes every kind of answer', () => {
    expect(describeDialogAnswer({ value: 'Not yet — keep planning' })).toBe('chose "Not yet — keep planning"');
    expect(describeDialogAnswer({ confirmed: true })).toBe('confirmed');
    expect(describeDialogAnswer({ confirmed: false })).toBe('declined');
    expect(describeDialogAnswer(CANCEL_DIALOG)).toBe('cancelled');
  });
});

const FAKE_PI = [
  "import { createInterface } from 'node:readline';",
  "const out = (record) => process.stdout.write(`${JSON.stringify(record)}\\n`);",
  "out({ type: 'extension_ui_request', id: 'ui-1', method: 'setStatus', statusKey: 'mission', statusText: 'mission: waiting for your goal' });",
  "out({ type: 'extension_ui_request', id: 'ui-2', method: 'setWidget', widgetKey: 'mission', widgetLines: ['✋ Mission O1 Two commands · awaiting approval', 'next: approve'], widgetPlacement: 'aboveEditor' });",
  `out(${JSON.stringify({ type: 'extension_ui_request', id: SELECT.id, method: 'select', title: SELECT.title, options: SELECT.options })});`,
  "out({ type: 'extension_ui_request', id: 'ui-4', method: 'confirm', title: 'Stop the worker?', message: 'It is running.' });",
  'let answers = 0;',
  "createInterface({ input: process.stdin }).on('line', (line) => {",
  '  const record = JSON.parse(line);',
  "  if (record.type !== 'extension_ui_response') return;",
  "  out({ type: 'extension_ui_request', id: `echo-${record.id}`, method: 'notify', notifyType: 'info', message: `response ${JSON.stringify(record)}` });",
  '  answers += 1;',
  "  if (answers === 2) out({ type: 'extension_ui_request', id: 'ui-9', method: 'setWidget', widgetKey: 'mission', widgetPlacement: 'aboveEditor' });",
  "}).on('close', () => process.exit(0));",
  '',
].join('\n');

function fakePi(): { readonly bin: string; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tower-e2e-rpc-'));
  dirs.push(dir);
  const script = join(dir, 'fake-pi.mjs');
  writeFileSync(script, FAKE_PI);
  const bin = join(dir, 'pi');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

function start(): PiRpc {
  const { bin, dir } = fakePi();
  const rpc = new PiRpc({ label: 'unit', piBin: bin, cwd: dir, args: [], env: process.env, logFile: join(dir, 'pi.log'), echo: false });
  sessions.push(rpc);
  return rpc;
}

async function responses(rpc: PiRpc): Promise<Record<string, unknown>[]> {
  await rpc.waitUntil(() => rpc.noticesSince(0).length >= 2, 10_000, 'two echoed responses', 50);
  return rpc.noticesSince(0).map((notice) => JSON.parse(notice.text.slice('response '.length)) as Record<string, unknown>);
}

describe('PiRpc dialogs', () => {
  it('records every dialog with its options and answers it through the responder, cancelling the rest', async () => {
    const rpc = start();
    rpc.dialogResponder = chooseOption(0, (request) => request.title.startsWith('Mission '));
    const answered = await responses(rpc);
    expect(answered).toEqual([
      { type: 'extension_ui_response', id: 'ui-3', value: 'Not yet — keep planning' },
      { type: 'extension_ui_response', id: 'ui-4', cancelled: true },
    ]);
    expect(rpc.dialogs.map(({ index, ...dialog }) => ({ ...dialog, recorded: rpc.events[index]?.id }))).toEqual([
      { ...SELECT, answer: { value: 'Not yet — keep planning' }, recorded: 'ui-3' },
      { id: 'ui-4', method: 'confirm', title: 'Stop the worker?', message: 'It is running.', options: [], answer: { cancelled: true }, recorded: 'ui-4' },
    ]);
  });

  it('cancels every dialog when no responder is set, as before', async () => {
    const rpc = start();
    expect((await responses(rpc)).map((response) => response.cancelled)).toEqual([true, true]);
    expect(rpc.dialogs.map((dialog) => dialog.answer)).toEqual([CANCEL_DIALOG, CANCEL_DIALOG]);
  });

  it('a throwing responder cancels the dialog instead of leaving it open', async () => {
    const rpc = start();
    rpc.dialogResponder = () => {
      throw new Error('boom');
    };
    expect((await responses(rpc)).map((response) => response.cancelled)).toEqual([true, true]);
  });
});

describe('PiRpc status and widget updates', () => {
  it('lists the setStatus and setWidget updates of one key with their event index, plain lines and placement', async () => {
    const rpc = start();
    await rpc.waitUntil(() => rpc.widgetUpdates('mission').length >= 2, 10_000, 'the widget to be cleared', 50);
    expect(rpc.statusUpdates('mission')).toEqual([{ index: 0, text: 'mission: waiting for your goal' }]);
    expect(rpc.statusTexts('mission')).toEqual(['mission: waiting for your goal']);
    expect(rpc.statusUpdates('tower')).toEqual([]);
    const widgets = rpc.widgetUpdates('mission');
    expect(widgets[0]).toEqual({ index: 1, lines: ['✋ Mission O1 Two commands · awaiting approval', 'next: approve'], plain: true, placement: 'aboveEditor' });
    expect(widgets[1]).toEqual(expect.objectContaining({ lines: undefined, plain: true, placement: 'aboveEditor' }));
    expect(rpc.widgetUpdates('mission', (widgets[1]?.index ?? 0) + 1)).toEqual([]);
  });

  it('flags widget content that is not plain lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-tower-e2e-rpc-'));
    dirs.push(dir);
    const script = join(dir, 'fake-pi.mjs');
    writeFileSync(script, "process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'w', method: 'setWidget', widgetKey: 'mission', widgetLines: [1, 2] }) + '\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
    const bin = join(dir, 'pi');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(bin, 0o755);
    const rpc = new PiRpc({ label: 'unit', piBin: bin, cwd: dir, args: [], env: process.env, logFile: join(dir, 'pi.log'), echo: false });
    sessions.push(rpc);
    await rpc.waitUntil(() => rpc.widgetUpdates('mission').length > 0, 10_000, 'the widget', 50);
    expect(rpc.widgetUpdates('mission')).toEqual([{ index: 0, lines: undefined, plain: false, placement: undefined }]);
  });
});
