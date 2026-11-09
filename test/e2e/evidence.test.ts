import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLogLine, userMessages } from './evidence.ts';

describe('parseLogLine', () => {
  it('takes everything after detail= as the detail, so commit=, kinds= and result= inside it never overwrite a real field', () => {
    const line =
      '2026-11-09T09:37:32.853Z autopilot start-validation milestone=MS1 commit=6d834c9 kinds=scrutiny,commands result=done detail=status=validating commit=1234567 kinds=scrutiny=ap-v-MS1-scrutiny-1,commands result=refused';
    expect(parseLogLine(line, 7)).toEqual({
      index: 7,
      at: '2026-11-09T09:37:32.853Z',
      actor: 'autopilot',
      action: 'start-validation',
      fields: {
        milestone: 'MS1',
        commit: '6d834c9',
        kinds: 'scrutiny,commands',
        result: 'done',
        detail: 'status=validating commit=1234567 kinds=scrutiny=ap-v-MS1-scrutiny-1,commands result=refused',
      },
      line,
    });
  });

  it('still reads the fields the scenarios use from lines with and without a detail', () => {
    expect(parseLogLine('2026-11-09T09:37:32.844Z tower merge branch=feat/reverse-command-and-test base=main merge_commit=6d834c9', 0).fields).toEqual({
      branch: 'feat/reverse-command-and-test',
      base: 'main',
      merge_commit: '6d834c9',
    });
    expect(parseLogLine('2026-11-09T09:37:07.372Z autopilot spawn-worker mission=M1 result=launched detail=name=ap-w-M1-1', 1).fields).toEqual({
      mission: 'M1',
      result: 'launched',
      detail: 'name=ap-w-M1-1',
    });
    expect(parseLogLine('2026-11-09T09:37:07.430Z autopilot spawn-worker mission=M1 name=ap-w-M1-1 result=started detail=name: ap-w-M1-1 kind: worker status: running', 2).fields).toEqual({
      mission: 'M1',
      name: 'ap-w-M1-1',
      result: 'started',
      detail: 'name: ap-w-M1-1 kind: worker status: running',
    });
    expect(parseLogLine('2026-11-09T09:40:00.000Z autopilot spawn-reviewer mission=M2 name=ap-r-M2-1 result=refused error=agent ap-r-M2-1 is already registered', 3).fields).toEqual({
      mission: 'M2',
      name: 'ap-r-M2-1',
      result: 'refused',
      error: 'agent ap-r-M2-1 is already registered',
    });
    expect(parseLogLine('2026-11-09T09:37:33.143Z autopilot commands milestone=MS1 commit=6d834c9 result=submitted round=1 verdict=pass revision=0', 4).fields).toEqual({
      milestone: 'MS1',
      commit: '6d834c9',
      result: 'submitted',
      round: '1',
      verdict: 'pass',
      revision: '0',
    });
  });
});

describe('userMessages', () => {
  it('lists the user messages of a session transcript with their time and text, whatever the content shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-tower-e2e-evidence-'));
    try {
      const path = join(dir, 'session.jsonl');
      const lines = [
        { type: 'session', timestamp: '2026-11-10T10:00:00.000Z', cwd: dir },
        { type: 'message', timestamp: '2026-11-10T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '# New mission — plan it with the human' }, { type: 'image', data: 'x' }] } },
        { type: 'message', timestamp: '2026-11-10T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Questions?' }] } },
        { type: 'message', timestamp: '2026-11-10T10:00:03.000Z', message: { role: 'user', content: 'My answers' } },
        { type: 'message', timestamp: '2026-11-10T10:00:04.000Z', message: { role: 'custom', customType: 'tower-agent-notification', content: 'done' } },
      ];
      writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`);
      expect(userMessages(path)).toEqual([
        { at: Date.parse('2026-11-10T10:00:01.000Z'), text: '# New mission — plan it with the human' },
        { at: Date.parse('2026-11-10T10:00:03.000Z'), text: 'My answers' },
      ]);
      expect(userMessages(join(dir, 'missing.jsonl'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
