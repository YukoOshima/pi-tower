import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { STATE_FILE } from '../protocol/paths.ts';

export interface HeadlessMilestone {
  readonly id: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly order: number;
  readonly status: string;
  readonly scrutiny: boolean;
  readonly userTesting: boolean;
  readonly commands: readonly string[];
  readonly qaInstructions: string | undefined;
}

export interface HeadlessObjective {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly status: string;
  readonly createdAt: string | undefined;
  readonly definitionOfDone: readonly string[];
  readonly acceptanceCommands: readonly string[];
  readonly milestones: readonly HeadlessMilestone[];
  readonly approvalReason: string | undefined;
  readonly blockedReason: string | undefined;
  readonly pausedReason: string | undefined;
  readonly notes: readonly string[];
}

export interface HeadlessFeature {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly milestone: string | undefined;
  readonly origin: string | undefined;
}

export interface HeadlessSnapshot {
  readonly objective: HeadlessObjective | undefined;
  readonly features: readonly HeadlessFeature[];
}

type Raw = Readonly<Record<string, unknown>>;

function record(value: unknown): Raw | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined;
}

function text(raw: Raw, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' ? value : undefined;
}

function texts(raw: Raw, key: string): string[] {
  const value = raw[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function records(raw: Raw, key: string): Raw[] {
  const value = raw[key];
  return Array.isArray(value) ? value.map(record).filter((item): item is Raw => item !== undefined) : [];
}

function parseMilestone(raw: Raw, index: number): HeadlessMilestone | undefined {
  const id = text(raw, 'id');
  if (id === undefined) return undefined;
  const validation = record(raw.validation) ?? {};
  return {
    id,
    title: text(raw, 'title') ?? id,
    description: text(raw, 'description'),
    order: typeof raw.order === 'number' ? raw.order : index,
    status: text(raw, 'status') ?? 'pending',
    scrutiny: validation.scrutiny !== false,
    userTesting: validation.userTesting !== false,
    commands: texts(validation, 'commands'),
    qaInstructions: text(validation, 'qaInstructions'),
  };
}

export function parseHeadlessObjective(value: unknown): HeadlessObjective | undefined {
  const raw = record(value);
  const id = raw === undefined ? undefined : text(raw, 'id');
  const status = raw === undefined ? undefined : text(raw, 'status');
  if (raw === undefined || id === undefined || status === undefined) return undefined;
  const milestones = records(raw, 'milestones')
    .map(parseMilestone)
    .filter((milestone): milestone is HeadlessMilestone => milestone !== undefined)
    .sort((a, b) => a.order - b.order);
  return {
    id,
    title: text(raw, 'title') ?? id,
    goal: text(raw, 'goal') ?? '',
    status,
    createdAt: text(raw, 'createdAt'),
    definitionOfDone: texts(raw, 'definitionOfDone'),
    acceptanceCommands: texts(raw, 'acceptanceCommands'),
    milestones,
    approvalReason: text(raw, 'approvalReason'),
    blockedReason: text(raw, 'blockedReason'),
    pausedReason: text(raw, 'pausedReason'),
    notes: texts(raw, 'notes'),
  };
}

export function parseHeadlessSnapshot(value: unknown): HeadlessSnapshot {
  const raw = record(value) ?? {};
  const features: HeadlessFeature[] = [];
  for (const mission of records(raw, 'missions')) {
    const id = text(mission, 'id');
    if (id === undefined) continue;
    features.push({
      id,
      title: text(mission, 'title') ?? id,
      status: text(mission, 'status') ?? 'planned',
      milestone: text(mission, 'milestone'),
      origin: text(mission, 'origin'),
    });
  }
  return { objective: parseHeadlessObjective(raw.objective), features };
}

export function headlessStatePath(cwd: string): string {
  return join(cwd, STATE_FILE);
}

export async function readHeadlessSnapshot(cwd: string): Promise<HeadlessSnapshot | undefined> {
  let content: string;
  try {
    content = await readFile(headlessStatePath(cwd), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseHeadlessSnapshot(JSON.parse(content) as unknown);
}
