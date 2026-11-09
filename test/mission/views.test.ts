import { describe, expect, it } from 'vitest';

import {
  resolveTowerModels,
  type TowerConfig,
  type TowerConfigValue,
  type TowerModelSpec,
  type TowerPrimaryModel,
} from '../../src/config/index.ts';
import { MISSION_GOAL_QUESTION, MISSION_MODELS_HINT, missionCommandsFor } from '../../src/mission/texts.ts';
import {
  missionModelLines,
  renderMissionControl,
  renderMissionHeader,
  renderMissionPlanning,
} from '../../src/mission/views.ts';
import type { TowerObjective } from '../../src/protocol/index.ts';

const SESSION: TowerPrimaryModel = { provider: 'prov', modelId: 'session-model', thinkingLevel: 'medium' };

function config(roles: TowerConfig['roles']): TowerConfig {
  return { roles, models: {}, files: [] };
}

function spec(model: string, thinkingLevel?: TowerModelSpec['thinkingLevel']): TowerModelSpec {
  const [provider = '', modelId = ''] = model.split('/');
  return thinkingLevel === undefined ? { provider, modelId } : { provider, modelId, thinkingLevel };
}

function globalFile(value: TowerModelSpec): TowerConfigValue<TowerModelSpec> {
  return { value, source: { kind: 'file', scope: 'global', path: '/home/user/.pi/agent/tower.json' } };
}

function objective(status: TowerObjective['status']): TowerObjective {
  return {
    id: 'O1',
    title: 'CSV and JSON export',
    goal: 'export',
    definitionOfDone: ['works'],
    acceptanceCommands: [],
    status,
    milestones: [],
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
    createdAt: '2026-11-09T10:00:00.000Z',
    notes: [],
  };
}

describe('mission model lines', () => {
  it('names every configured source and shows the validator as the reviewer it inherits', () => {
    const resolved = resolveTowerModels(
      config({
        orchestrator: globalFile(spec('anthropic/claude-opus-5-5', 'high')),
        worker: {
          value: spec('anthropic/claude-sonnet-5-5'),
          source: { kind: 'file', scope: 'project', path: '/repo/.pi/tower.json' },
        },
        reviewer: { value: spec('openai/gpt-5.5', 'high'), source: { kind: 'env', variable: 'PI_TOWER_REVIEWER_MODEL' } },
      }),
      SESSION,
    );

    expect(missionModelLines({ resolved })).toEqual([
      'Orchestrator  anthropic/claude-opus-5-5 · high  (global tower.json)',
      'Worker        anthropic/claude-sonnet-5-5       (project tower.json)',
      'Reviewer      openai/gpt-5.5 · high             (env PI_TOWER_REVIEWER_MODEL)',
      'Validator     same as reviewer',
    ]);
  });

  it('falls back to the session model and shows the inherited roles as the orchestrator', () => {
    const resolved = resolveTowerModels(config({}), SESSION);

    expect(missionModelLines({ resolved })).toEqual([
      'Orchestrator  prov/session-model · medium  (session model)',
      'Worker        prov/session-model · medium  (same as orchestrator)',
      'Reviewer      prov/session-model · medium  (same as orchestrator)',
      'Validator     same as orchestrator',
    ]);
  });

  it('shows an explicitly configured validator and a flag source', () => {
    const resolved = resolveTowerModels(
      config({
        reviewer: globalFile(spec('openai/gpt-5.5')),
        validator: { value: spec('openai/gpt-5.5', 'xhigh'), source: { kind: 'flag', flag: 'tower-validator-model' } },
      }),
      SESSION,
    );

    expect(missionModelLines({ resolved })).toEqual([
      'Orchestrator  prov/session-model · medium  (session model)',
      'Worker        prov/session-model · medium  (same as orchestrator)',
      'Reviewer      openai/gpt-5.5               (global tower.json)',
      'Validator     openai/gpt-5.5 · xhigh       (--tower-validator-model)',
    ]);
  });

  it('explains a missing model and a configuration that could not be loaded', () => {
    const resolved = resolveTowerModels(config({}), undefined);
    const lines = missionModelLines({ resolved });

    expect(lines[0]).toBe(
      'Orchestrator  (none) — select a session model with /model, or set one with /mission models orchestrator <provider/model[:thinking]>',
    );
    expect(lines[1]).toContain('/mission models worker <provider/model[:thinking]>');
    expect(lines[3]).toBe('Validator     same as orchestrator');
    expect(missionModelLines({ loadError: 'tower.json: unexpected token' })).toEqual([
      'Models        could not be loaded: tower.json: unexpected token — fix tower.json, then check /mission models',
    ]);
    expect(missionModelLines({})).toEqual(['Models        not loaded yet — /mission models shows them']);
  });
});

describe('mission header', () => {
  it('shows the models, the base branch with the parallelism limit, the models hint and the goal question', () => {
    const resolved = resolveTowerModels(config({ orchestrator: globalFile(spec('anthropic/claude-opus-5-5', 'high')) }), SESSION);

    const header = renderMissionHeader({ models: { resolved }, base: 'main', initialized: false, maxRunningAgents: 256 });

    expect(header.split('\n')).toEqual([
      '  Orchestrator  anthropic/claude-opus-5-5 · high  (global tower.json)',
      '  Worker        anthropic/claude-opus-5-5 · high  (same as orchestrator)',
      '  Reviewer      anthropic/claude-opus-5-5 · high  (same as orchestrator)',
      '  Validator     same as orchestrator',
      '  Base branch   main · features run in parallel (up to 256 agents)',
      `  ${MISSION_MODELS_HINT}`,
      MISSION_GOAL_QUESTION,
    ]);
  });

  it('says when it initialized the workspace and mentions the previous mission', () => {
    const header = renderMissionHeader({
      models: {},
      base: 'develop',
      initialized: true,
      maxRunningAgents: 4,
      previous: objective('completed'),
    });

    expect(header).toContain('  Base branch   develop (tower workspace initialized now) · features run in parallel (up to 4 agents)');
    expect(header).toContain('Previous mission O1 "CSV and JSON export" is completed — your goal starts a new one.');
    expect(header.split('\n').at(-1)).toBe(MISSION_GOAL_QUESTION);
  });

  it('renders the planning view and Mission Control with the commands of the state', () => {
    const resolved = resolveTowerModels(config({}), SESSION);

    expect(renderMissionPlanning({ resolved }, 'Add   a CSV export')).toContain(
      'The orchestrator is planning your goal: "Add a CSV export".',
    );
    expect(renderMissionPlanning({ resolved }, undefined)).toContain(
      'The orchestrator is planning the goal you handed over. Answer its questions in plain messages;',
    );
    const control = renderMissionControl({
      models: { resolved },
      objective: objective('awaiting-approval'),
      statusMarkdown: '# Mission O1 — CSV and JSON export\nstatus body',
    });
    const [models, status, commands] = control.split('\n\n');
    expect(models?.split('\n')[0]).toBe('## Models');
    expect(models).toContain('Orchestrator  prov/session-model · medium  (session model)');
    expect(status).toBe('# Mission O1 — CSV and JSON export\nstatus body');
    expect(commands?.split('\n')).toEqual(['## Commands', ...missionCommandsFor('awaiting-approval')]);
    expect(commands).toContain('/mission approve — approve the plan and start the mission');
  });

  it('lists the commands available in every objective state', () => {
    expect(missionCommandsFor('planning')[0]).toContain('Answer the orchestrator');
    expect(missionCommandsFor('executing')).toContain('/mission pause [reason] — pause: running agents finish their turn, nothing new starts');
    expect(missionCommandsFor('paused')[0]).toBe('/mission resume — continue the mission');
    expect(missionCommandsFor('blocked')).toContain('/mission <goal> — start a new mission instead');
    expect(missionCommandsFor('completed')[0]).toBe('/mission — start a new mission');
  });
});
