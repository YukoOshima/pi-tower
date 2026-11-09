import { TOWER_VALIDATE_DESCRIPTION } from '../../prompts/index.ts';
import { TOWER_NAME, validationResultSubject } from '../../protocol/index.ts';
import { deliverTowerMessage } from '../delivery.ts';
import {
  isMainAgent,
  objectiveSettingsOf,
  runTowerTool,
  validationSettingsOf,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import {
  TOWER_VALIDATE_VALIDATORS_ONLY,
  TowerValidateToolInputSchema,
  towerValidateInputProblem,
} from './validate.ts';

export function createTowerValidateTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerValidateToolInputSchema> {
  return {
    name: 'TowerValidate',
    label: 'Tower Validate',
    description: TOWER_VALIDATE_DESCRIPTION,
    parameters: TowerValidateToolInputSchema,
    async run(args) {
      if (isMainAgent(caller)) return { isError: true, output: TOWER_VALIDATE_VALIDATORS_ONLY };
      const problem = towerValidateInputProblem(args);
      if (problem !== undefined) return { output: problem, isError: true };
      return runTowerTool(async () => {
        const store = host.store();
        const state = await store.load();
        const name = store.resolveCallerName(state, caller.agentId);
        const entry = store.findAgent(state, name);
        if (name === TOWER_NAME || entry?.kind !== 'validator') {
          return {
            isError: true,
            output: `agent "${name}" is ${entry === undefined ? 'not a roster agent' : `a ${entry.kind}`}, not a validator — ${TOWER_VALIDATE_VALIDATORS_ONLY}; workers finish with TowerComplete and reviewers with TowerReview`,
          };
        }
        const result = await store.submitValidation(
          name,
          {
            milestone: args.milestone.trim(),
            kind: args.kind,
            verdict: args.verdict,
            ...(args.failures === undefined ? {} : { failures: args.failures }),
            ...(args.checks === undefined ? {} : { checks: args.checks }),
            evidence: args.evidence,
          },
          validationSettingsOf(objectiveSettingsOf(host)),
        );
        const delivery =
          result.message !== undefined ? await deliverTowerMessage(host, state, result.message) : '';
        const { round, milestone, objective } = result;
        const lines = [
          `validation recorded: ${validationResultSubject(milestone.id, round)} on commit ${round.validatedCommit.slice(0, 7)}`,
          `file: ${round.file}`,
          `milestone ${milestone.id} is now ${milestone.status}`,
          ...(objective.status === 'blocked'
            ? [`objective ${objective.id} is now blocked: ${objective.blockedReason ?? 'see the objective status'}`]
            : []),
          `notified: ${result.message === undefined ? '(none)' : `${result.message.item.to} (${result.message.item.subject})`}`,
        ];
        if (result.notificationError !== undefined) {
          lines.push(`notification error: ${result.notificationError}`);
        }
        if (result.activityLogError !== undefined) {
          lines.push(`activity log error: ${result.activityLogError}`);
        }
        lines.push(
          'Your verdict is final for this round: do not call TowerValidate again — finish with a short summary (verdict, number of failures, what you exercised).',
        );
        if (delivery.length > 0) lines.push(delivery);
        return {
          output: lines.join('\n'),
          ...(result.notificationError === undefined && result.activityLogError === undefined
            ? {}
            : { isError: true }),
        };
      });
    },
  };
}
