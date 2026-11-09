import { describe, expect, it } from 'vitest';

import type { TowerObjectiveStatus, TowerRosterEntry, TowerState } from '../../src/protocol/index.ts';
import {
  autopilotDrivesObjective,
  isAutopilotInboxMessage,
  isObjectiveAgent,
} from '../../src/tower/autopilotEvents.ts';

function state(status: TowerObjectiveStatus = 'executing'): TowerState {
  return {
    missions: [
      { id: 'M1', milestone: 'MS1' },
      { id: 'M2', milestone: 'MS2' },
      { id: 'M3' },
      { id: 'M4', milestone: 'MS0' },
    ],
    objective: { id: 'O2', status, milestones: [{ id: 'MS1' }, { id: 'MS2' }] },
  } as unknown as TowerState;
}

function agent(entry: Partial<TowerRosterEntry> & Pick<TowerRosterEntry, 'kind'>): TowerRosterEntry {
  return { name: 'a', agentId: 'agent-1', spawnedAt: '2026-11-09T00:00:00.000Z', ...entry };
}

describe('autopilotDrivesObjective', () => {
  it('holds only while the objective executes with the autopilot on', () => {
    expect(autopilotDrivesObjective(state('executing'), true)).toBe(true);
    expect(autopilotDrivesObjective(state('executing'), false)).toBe(false);
    for (const status of ['planning', 'awaiting-approval', 'paused', 'completed', 'blocked'] as const) {
      expect(autopilotDrivesObjective(state(status), true)).toBe(false);
    }
    expect(autopilotDrivesObjective({ missions: [] } as unknown as TowerState, true)).toBe(false);
    expect(autopilotDrivesObjective(undefined, true)).toBe(false);
  });
});

describe('isObjectiveAgent', () => {
  it('covers workers and reviewers of the current objective features and its validators', () => {
    expect(isObjectiveAgent(state(), agent({ kind: 'worker', missionId: 'M1' }))).toBe(true);
    expect(isObjectiveAgent(state(), agent({ kind: 'reviewer', reviewMissionId: 'M2' }))).toBe(true);
    expect(isObjectiveAgent(state(), agent({ kind: 'validator', milestoneId: 'MS2' }))).toBe(true);
  });

  it('leaves out agents without a roster entry, milestone-less missions and earlier objectives', () => {
    expect(isObjectiveAgent(state(), undefined)).toBe(false);
    expect(isObjectiveAgent(state(), agent({ kind: 'worker', missionId: 'M3' }))).toBe(false);
    expect(isObjectiveAgent(state(), agent({ kind: 'worker', missionId: 'M4' }))).toBe(false);
    expect(isObjectiveAgent(state(), agent({ kind: 'reviewer' }))).toBe(false);
    expect(isObjectiveAgent(state(), agent({ kind: 'validator', milestoneId: 'MS0' }))).toBe(false);
  });
});

describe('isAutopilotInboxMessage', () => {
  it('treats completions, review results and validation results of the objective as mechanical', () => {
    expect(isAutopilotInboxMessage(state(), { action: 'complete', scope: 'M1', missionId: 'M1' })).toBe(true);
    expect(isAutopilotInboxMessage(state(), { action: 'review-result', scope: 'M2' })).toBe(true);
    expect(isAutopilotInboxMessage(state(), { action: 'review-request', missionId: 'M1' })).toBe(true);
    expect(isAutopilotInboxMessage(state(), { action: 'survey-summary', missionId: 'M2' })).toBe(true);
    expect(isAutopilotInboxMessage(state(), { action: 'validation-result', scope: 'MS1' })).toBe(true);
  });

  it('keeps judgment and messages outside the objective', () => {
    expect(isAutopilotInboxMessage(state(), { missionId: 'M1' })).toBe(false);
    expect(isAutopilotInboxMessage(state(), { action: 'clarify-request', missionId: 'M1' })).toBe(false);
    expect(isAutopilotInboxMessage(state(), { action: 'blocker', scope: 'M1' })).toBe(false);
    expect(isAutopilotInboxMessage(state(), { action: 'complete', scope: 'M3', missionId: 'M3' })).toBe(false);
    expect(isAutopilotInboxMessage(state(), { action: 'review-result', scope: 'M4' })).toBe(false);
    expect(isAutopilotInboxMessage(state(), { action: 'review-result' })).toBe(false);
    expect(isAutopilotInboxMessage(state(), { action: 'validation-result', scope: 'MS0' })).toBe(false);
    expect(isAutopilotInboxMessage(state(), { action: 'validation-result', scope: 'M1' })).toBe(false);
  });
});
