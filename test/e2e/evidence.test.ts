import { describe, expect, it } from 'vitest';

import { parseLogLine } from './evidence.ts';

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
