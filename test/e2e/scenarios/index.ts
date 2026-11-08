import type { ScenarioDefinition } from '../scenario.ts';
import { s1Models } from './s1Models.ts';
import { s2Commands } from './s2Commands.ts';

export const SCENARIOS: readonly ScenarioDefinition[] = [s1Models, s2Commands];
