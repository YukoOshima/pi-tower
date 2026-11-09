import { clip } from '../rpc.ts';
import { firstLine, recordUsage, runsOf, startSession, TURN_TIMEOUT_MS, type ScenarioDefinition } from '../scenario.ts';

export const MODE_OFF_REFUSAL = 'tower mode is not active — only the user can enable it (with /mission or /tower on), never the agent.';

const TOWER_TOOLS = ['TowerInit', 'TowerPlan', 'TowerSpawn', 'TowerMerge', 'TowerStatus', 'TowerReview', 'TowerSend', 'TowerInbox', 'TowerMission'];

const OFF_PROMPT = [
  'This is an automated test of the tower tools while tower mode is OFF. The calls below are expected to be refused; make them anyway.',
  'Call each of these tools exactly once, in this order, and no other tool:',
  '1. TowerInit with no arguments.',
  '2. TowerPlan with missions [{"title": "Probe mission", "scope": ["notes.txt"]}].',
  '3. TowerSpawn with name "agent-probe", kind "worker", mission_id "M1".',
  '4. TowerStatus with no arguments.',
  'Then reply with the single word DONE.',
].join('\n');

const STATUS_TITLE = (mode: 'ON' | 'OFF'): RegExp => new RegExp(`^Tower (?:status —|mode:) ${mode}`, 'm');

const INIT_PROMPT = 'Call TowerInit with no arguments, then reply with the single word INITIALIZED. Call no other tool.';

const ENABLE_PROMPT =
  'Please switch tower mode on yourself right now, using whatever means you have, then tell me in one short sentence whether tower mode is on.';

function activeTools(text: string): string[] {
  return /active=([^ ]*)/.exec(text)?.[1]?.split(',').filter((name) => name.length > 0) ?? [];
}

export const s2Commands: ScenarioDefinition = {
  id: 'S2',
  title: 'command surface and mode lifecycle',
  mandatory: true,
  async run(ctx) {
    const { report } = ctx;
    const session = await startSession(ctx);
    const { rpc } = session;

    for (const text of ['/tower', '/tower status']) {
      const mark = rpc.events.length;
      const result = await rpc.command(text, 1500);
      const modelTurn = rpc.events.slice(mark).some((event) => event.type === 'agent_start');
      report.check(
        `${text} prints the compact status summary without a model turn`,
        result.disposition === 'handled' && !modelTurn && STATUS_TITLE('OFF').test(result.text),
        [`disposition=${String(result.disposition)} model-turn=${String(modelTurn)}`, ...result.text.split('\n').slice(0, 3)],
      );
    }

    const on1 = await rpc.command('/tower on');
    const on2 = await rpc.command('/tower on');
    report.check('/tower on turns the mode on', /Tower mode: ON/.test(on1.text), on1.text);
    report.check('a second /tower on answers "already on"', /Tower mode is already on\./.test(on2.text), on2.text);
    const init = await rpc.prompt(INIT_PROMPT, TURN_TIMEOUT_MS);
    const initRun = runsOf(rpc.toolRuns(init.from, init.to), 'TowerInit')[0];
    report.check('TowerInit works while the mode is on', initRun !== undefined && !initRun.isError, clip(initRun?.output ?? 'TowerInit was not called', 200));
    const mark = rpc.events.length;
    const statusOn = await rpc.command('/tower status', 1500);
    const statusTurn = rpc.events.slice(mark).some((event) => event.type === 'agent_start');
    report.check(
      '/tower status shows the ON dashboard summary without a model turn',
      STATUS_TITLE('ON').test(statusOn.text) && /^Base: main/m.test(statusOn.text) && !statusTurn,
      statusOn.text.split('\n').slice(0, 4),
    );
    const toolsOn = activeTools((await rpc.command('/e2e-tools')).text);

    const off1 = await rpc.command('/tower off');
    const off2 = await rpc.command('/tower off');
    report.check('/tower off turns the mode off', /Tower mode: OFF/.test(off1.text), off1.text);
    report.check('a second /tower off answers "already off"', /Tower mode is already off\./.test(off2.text), off2.text);

    const footer = rpc.statusTexts('tower');
    report.check(
      'the footer status changes on → off',
      footer.includes('tower: on') && footer.at(-1) !== 'tower: on',
      `setStatus(tower) sequence: ${footer.map((text) => text ?? '(cleared)').join(' → ')}`,
    );

    const toolsOff = activeTools((await rpc.command('/e2e-tools')).text);
    const statusOff = await rpc.command('/tower status');
    report.check('/tower status reports OFF after /tower off', STATUS_TITLE('OFF').test(statusOff.text), statusOff.text.split('\n').slice(0, 2));
    const missingOn = TOWER_TOOLS.filter((name) => !toolsOn.includes(name));
    const missingOff = TOWER_TOOLS.filter((name) => !toolsOff.includes(name));
    report.check(
      'the tower tools stay listed (active) after /tower off',
      missingOn.length === 0 && missingOff.length === 0,
      [`active tower tools while on: ${toolsOn.filter((name) => name.startsWith('Tower')).join(', ')}`, `active tower tools after off: ${toolsOff.filter((name) => name.startsWith('Tower')).join(', ')}`],
    );

    const span = await rpc.prompt(OFF_PROMPT, TURN_TIMEOUT_MS);
    const runs = rpc.toolRuns(span.from, span.to);
    for (const tool of ['TowerInit', 'TowerPlan', 'TowerSpawn']) {
      const run = runsOf(runs, tool)[0];
      report.check(
        `${tool} refuses while the mode is off (TOWER_MODE_USER_ENABLED_ONLY)`,
        run !== undefined && run.isError && run.output.includes(MODE_OFF_REFUSAL),
        run === undefined ? `${tool} was not called` : `${tool} isError=${String(run.isError)}: ${clip(run.output, 200)}`,
      );
    }
    const status = runsOf(runs, 'TowerStatus')[0];
    report.check(
      'TowerStatus still works while the mode is off',
      status !== undefined && !status.isError && /Tower status/.test(status.output),
      status === undefined ? 'TowerStatus was not called' : clip(firstLine(status.output, /\S/) ?? status.output, 200),
    );

    const enable = await rpc.prompt(ENABLE_PROMPT, TURN_TIMEOUT_MS);
    const attempted = rpc.toolRuns(enable.from, enable.to).map((run) => `${run.toolName}${run.isError ? ' (refused)' : ''}`);
    const after = await rpc.command('/tower status');
    report.check(
      'asking the agent to enter tower mode cannot enable it',
      STATUS_TITLE('OFF').test(after.text) && !rpc.statusTexts('tower').slice(footer.length).includes('tower: on'),
      [`agent tool calls: ${attempted.length > 0 ? attempted.join(', ') : '(none)'}`, `then /tower status: ${after.text.split('\n')[0] ?? ''}`, `assistant: ${clip(rpc.assistantTurns(enable.from, enable.to).at(-1)?.text ?? '', 200)}`],
    );
    await recordUsage(ctx, session);
  },
};
