import type { ScenarioDefinition } from '../scenario.ts';
import { s13Budget } from './s13Budget.ts';
import { s1Models } from './s1Models.ts';
import { s2Commands } from './s2Commands.ts';
import { s3Lifecycle } from './s3Lifecycle.ts';
import { s4Rework } from './s4Rework.ts';
import { s7Stop } from './s7Stop.ts';
import { s8Guards } from './s8Guards.ts';

export const SCENARIOS: readonly ScenarioDefinition[] = [s1Models, s2Commands, s3Lifecycle, s8Guards, s4Rework, s7Stop, s13Budget];
