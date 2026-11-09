import { describe, expect, it } from 'vitest';

import { DEFAULT_SCENARIOS, OBJECTIVE_SCENARIOS, parseScenarios, SCENARIO_IDS } from './settings.ts';

describe('parseScenarios', () => {
  it('runs S1 to S13 by default and the objective scenarios, S18 and S19 included, only when selected', () => {
    expect(parseScenarios(undefined)).toEqual(['S1', 'S2', 'S3', 'S8', 'S4', 'S7', 'S13']);
    expect(DEFAULT_SCENARIOS).toEqual(parseScenarios(undefined));
    expect(parseScenarios('objective')).toEqual(['S15', 'S16', 'S17', 'S18', 'S19']);
    expect(OBJECTIVE_SCENARIOS).toEqual(parseScenarios('objective'));
    expect(parseScenarios('all,objective')).toEqual([...SCENARIO_IDS]);
  });

  it('selects scenarios by id in any case and runs them in the canonical order', () => {
    expect(parseScenarios('s18')).toEqual(['S18']);
    expect(parseScenarios('S19, S15 ,s2')).toEqual(['S2', 'S15', 'S19']);
  });

  it('refuses an unknown id and names the known ids and keywords', () => {
    expect(() => parseScenarios('S18,S99')).toThrow('unknown scenario(s) S99 — known: S1, S2, S3, S8, S4, S7, S13, S15, S16, S17, S18, S19, all (S1,S2,S3,S8,S4,S7,S13), objective (S15,S16,S17,S18,S19)');
  });
});
