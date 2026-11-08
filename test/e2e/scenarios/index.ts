import type { ScenarioDefinition } from '../scenario.ts';
import { s1Models } from './s1Models.ts';
import { s2Commands } from './s2Commands.ts';
import { s3Lifecycle } from './s3Lifecycle.ts';
import { s8Guards } from './s8Guards.ts';

export const SCENARIOS: readonly ScenarioDefinition[] = [s1Models, s2Commands, s3Lifecycle, s8Guards];
