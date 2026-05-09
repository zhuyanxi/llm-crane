import {
  TaskResponseSchema,
  type PipelineTraceEvent,
  type RerunTaskRequest,
  type TaskResponse,
} from '@llm-crane/schemas';
import { buildModelPolicyOverrides, type ModelOverrideCatalog } from './modelOverride';

export type VerificationActionId = 'retry' | 'upgrade-model' | 'manual-confirm';

export type VerificationActionButtonView = {
  actionId: VerificationActionId;
  label: string;
  detail: string;
  tone: 'primary' | 'secondary';
};

export type VerificationInsightView = {
  summary: string;
  detail: string;
  suggestedActionLabel: string;
  reasons: string[];
  findings: string[];
  actions: VerificationActionButtonView[];
};

function formatUsd(value: number): string {
  if (value < 0.001) {
    return `$${value.toFixed(6)}`;
  }

  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }

  return `$${value.toFixed(2)}`;
}

function toTimestamp(createTimestamp: () => string): string {
  return createTimestamp();
}

function createTraceEvent(
  stage: string,
  status: PipelineTraceEvent['status'],
  detail: string,
  metadata: Record<string, string | number | boolean> = {},
  createTimestamp: () => string = () => new Date().toISOString(),
): PipelineTraceEvent {
  return {
    stage,
    status,
    timestamp: toTimestamp(createTimestamp),
    detail,
    metadata,
  };
}

function resolveUpgradeTargetModelId(taskResponse: TaskResponse, catalog: ModelOverrideCatalog): string | undefined {
  if (!catalog.available) {
    return undefined;
  }

  if (taskResponse.selectedProvider.modelId === catalog.defaultComplexModel) {
    return undefined;
  }

  return catalog.defaultComplexModel;
}

function formatSuggestedActionLabel(action: TaskResponse['verifierResult'] extends infer T
  ? T extends { suggestedAction: infer U }
    ? U
    : never
  : never): string {
  switch (action) {
    case 'retry':
      return 'Retry suggested';
    case 'upgrade-model':
      return 'Model upgrade suggested';
    case 'manual-confirm':
      return 'Manual confirmation suggested';
    case 'proceed':
    default:
      return 'Proceed';
  }
}

function formatFinding(finding: NonNullable<TaskResponse['verifierResult']>['findings'][number]): string {
  const source = finding.verifierId ? `${finding.verifierId}` : 'verifier';
  return `${finding.severity} · ${source} · ${finding.code} · ${finding.summary}: ${finding.detail}`;
}

function findLatestTraceEvent(taskResponse: TaskResponse, stage: string): PipelineTraceEvent | undefined {
  return [...taskResponse.trace].reverse().find((event) => event.stage === stage);
}

export function hasVerificationFailure(taskResponse: TaskResponse): boolean {
  return taskResponse.verifierResult?.verdict === 'fail';
}

export function buildVerificationInsight(taskResponse: TaskResponse, catalog: ModelOverrideCatalog): VerificationInsightView {
  const verifierResult = taskResponse.verifierResult;
  if (!verifierResult) {
    return {
      summary: 'No verifier result',
      detail: 'Task response did not include verifier metadata.',
      suggestedActionLabel: 'No action',
      reasons: [],
      findings: [],
      actions: [],
    };
  }

  const upgradeTargetModelId = resolveUpgradeTargetModelId(taskResponse, catalog);
  const upgradeCostEvent = findLatestTraceEvent(taskResponse, 'verification.upgrade.cost');
  const declinedUpgradeEvent = findLatestTraceEvent(taskResponse, 'verification.upgrade.declined');
  const manualConfirmEvent = findLatestTraceEvent(taskResponse, 'verification.manual-confirm.accepted');
  const detailParts = [verifierResult.summary, `Suggested action: ${formatSuggestedActionLabel(verifierResult.suggestedAction)}.`];

  if (verifierResult.suggestedAction === 'upgrade-model' && !upgradeTargetModelId) {
    detailParts.push('Upgrade unavailable because current run already uses configured complex default model.');
  }

  if (upgradeCostEvent?.detail) {
    detailParts.push(upgradeCostEvent.detail);
  }

  if (declinedUpgradeEvent?.detail) {
    detailParts.push(declinedUpgradeEvent.detail);
  }

  if (manualConfirmEvent?.detail) {
    detailParts.push(manualConfirmEvent.detail);
  }

  const actions: VerificationActionButtonView[] = [];
  if (verifierResult.verdict !== 'pass') {
    if (verifierResult.suggestedAction === 'retry') {
      actions.push({
        actionId: 'retry',
        label: 'Retry executor',
        detail: 'Rerun executor and verifier from latest checkpoint with current model settings.',
        tone: 'primary',
      });
      actions.push({
        actionId: 'manual-confirm',
        label: 'Keep current result',
        detail: 'Accept verifier risk and keep current result without rerun.',
        tone: 'secondary',
      });
    } else if (verifierResult.suggestedAction === 'upgrade-model' && upgradeTargetModelId) {
      actions.push({
        actionId: 'upgrade-model',
        label: `Upgrade to ${upgradeTargetModelId}`,
        detail: `Rerun executor and verifier with complex default model ${upgradeTargetModelId}. Extra cost will be recorded.`,
        tone: 'primary',
      });
      actions.push({
        actionId: 'manual-confirm',
        label: 'Keep current result',
        detail: 'Refuse automatic upgrade and keep current result.',
        tone: 'secondary',
      });
    } else {
      actions.push({
        actionId: 'manual-confirm',
        label: 'Keep current result',
        detail: verifierResult.suggestedAction === 'upgrade-model'
          ? 'Upgrade unavailable. Keep current result or change model manually before rerun.'
          : 'Accept verifier risk and keep current result without rerun.',
        tone: 'primary',
      });
    }
  }

  return {
    summary: `${verifierResult.verdict} · ${verifierResult.verifierKind}`,
    detail: detailParts.join(' '),
    suggestedActionLabel: formatSuggestedActionLabel(verifierResult.suggestedAction),
    reasons: verifierResult.reasons,
    findings: verifierResult.findings.map((finding) => formatFinding(finding)),
    actions,
  };
}

function appendTraceEvent(taskResponse: TaskResponse, event: PipelineTraceEvent): TaskResponse {
  return TaskResponseSchema.parse({
    ...taskResponse,
    trace: [...taskResponse.trace, event],
    checkpoint: {
      ...taskResponse.checkpoint,
      trace: [...taskResponse.checkpoint.trace, event],
    },
  });
}

export function buildVerificationActionRerunRequest(
  taskResponse: TaskResponse,
  actionId: Extract<VerificationActionId, 'retry' | 'upgrade-model'>,
  catalog: ModelOverrideCatalog,
  createTimestamp: () => string = () => new Date().toISOString(),
): RerunTaskRequest {
  if (actionId === 'retry') {
    const event = createTraceEvent(
      'verification.retry.requested',
      'retrying',
      'User accepted verifier retry suggestion. Rerunning executor and verifier from latest checkpoint.',
      {
        previousModelId: taskResponse.selectedProvider.modelId,
        verifierVerdict: taskResponse.verifierResult?.verdict ?? 'warning',
      },
      createTimestamp,
    );

    return {
      targetStageId: 'executor',
      checkpoint: {
        ...taskResponse.checkpoint,
        trace: [...taskResponse.checkpoint.trace, event],
      },
    };
  }

  const upgradeTargetModelId = resolveUpgradeTargetModelId(taskResponse, catalog);
  if (!upgradeTargetModelId) {
    throw new Error('Automatic model upgrade unavailable for current verifier result.');
  }

  const event = createTraceEvent(
    'verification.upgrade.requested',
    'retrying',
    `User accepted verifier upgrade suggestion. Rerunning executor and verifier with complex default model ${upgradeTargetModelId}.`,
    {
      previousModelId: taskResponse.selectedProvider.modelId,
      upgradedModelId: upgradeTargetModelId,
      verifierVerdict: taskResponse.verifierResult?.verdict ?? 'warning',
    },
    createTimestamp,
  );

  return {
    targetStageId: 'executor',
    checkpoint: {
      ...taskResponse.checkpoint,
      taskRequest: {
        ...taskResponse.checkpoint.taskRequest,
        policyOverrides: buildModelPolicyOverrides('complex-default', '', catalog),
      },
      trace: [...taskResponse.checkpoint.trace, event],
    },
  };
}

export function createVerificationDecisionResponse(
  taskResponse: TaskResponse,
  decision: 'manual-confirm' | 'upgrade-declined',
  catalog: ModelOverrideCatalog,
  createTimestamp: () => string = () => new Date().toISOString(),
): TaskResponse {
  if (decision === 'manual-confirm') {
    return appendTraceEvent(
      taskResponse,
      createTraceEvent(
        'verification.manual-confirm.accepted',
        'completed',
        `User manually confirmed current result after verifier suggested ${taskResponse.verifierResult?.suggestedAction ?? 'manual-confirm'}.`,
        {
          verifierVerdict: taskResponse.verifierResult?.verdict ?? 'warning',
          suggestedAction: taskResponse.verifierResult?.suggestedAction ?? 'manual-confirm',
        },
        createTimestamp,
      ),
    );
  }

  const upgradeTargetModelId = resolveUpgradeTargetModelId(taskResponse, catalog) ?? catalog.defaultComplexModel;
  return appendTraceEvent(
    taskResponse,
    createTraceEvent(
      'verification.upgrade.declined',
      'skipped',
      `User declined automatic upgrade to ${upgradeTargetModelId}. Current result kept without rerun.`,
      {
        previousModelId: taskResponse.selectedProvider.modelId,
        upgradedModelId: upgradeTargetModelId,
        verifierVerdict: taskResponse.verifierResult?.verdict ?? 'warning',
      },
      createTimestamp,
    ),
  );
}

export function annotateUpgradeResponse(
  previousResponse: TaskResponse,
  upgradedResponse: TaskResponse,
  createTimestamp: () => string = () => new Date().toISOString(),
): TaskResponse {
  const previousCost = previousResponse.costEstimate.totalCostUsd;
  const upgradedCost = upgradedResponse.costEstimate.totalCostUsd;
  const deltaCostUsd = previousCost !== undefined && upgradedCost !== undefined
    ? Math.max(0, upgradedCost - previousCost)
    : undefined;
  const detail = deltaCostUsd !== undefined
    ? `Automatic model upgrade rerun cost delta: ${formatUsd(deltaCostUsd)} USD compared with previous result.`
    : 'Automatic model upgrade rerun cost delta unavailable for one or both runs.';

  return appendTraceEvent(
    upgradedResponse,
    createTraceEvent(
      'verification.upgrade.cost',
      'completed',
      detail,
      {
        previousModelId: previousResponse.selectedProvider.modelId,
        upgradedModelId: upgradedResponse.selectedProvider.modelId,
        previousCostUsd: previousCost ?? false,
        upgradedCostUsd: upgradedCost ?? false,
        extraCostUsd: deltaCostUsd ?? false,
      },
      createTimestamp,
    ),
  );
}