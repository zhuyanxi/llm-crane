import type { TaskResponse } from '@llm-crane/schemas';
import { describeTaskModelOverride } from './modelOverride';

export type RoutingInsightView = {
  routeSummary: string;
  routeDetail: string;
  routeReason: string;
  overrideSummary: string;
  overrideDetail: string;
  earlyExitSummary: string;
  earlyExitDetail: string;
};

export function buildRoutingInsight(
  taskResponse: Pick<TaskResponse, 'routeDecision' | 'checkpoint' | 'reasonerResult' | 'pipeline' | 'selectedProvider'>,
): RoutingInsightView {
  const confidencePercent = Math.round(taskResponse.routeDecision.confidence * 100);
  const routeSummary = `${taskResponse.routeDecision.route} route · ${taskResponse.routeDecision.status}`;
  const routeDetailParts = [`${confidencePercent}% confidence`, `score=${taskResponse.routeDecision.complexityScore}`];
  if (taskResponse.routeDecision.strategy) {
    routeDetailParts.push(`strategy=${taskResponse.routeDecision.strategy}`);
  }

  const overrideInsight = describeTaskModelOverride(
    taskResponse.checkpoint.taskRequest.policyOverrides,
    taskResponse.selectedProvider.modelId,
  );

  const reasonParts = [taskResponse.routeDecision.reason];
  if (taskResponse.routeDecision.fallbackReason) {
    reasonParts.push(`Fallback: ${taskResponse.routeDecision.fallbackReason}`);
  }

  const { earlyExitSummary, earlyExitDetail } = buildEarlyExitInsight(taskResponse);

  return {
    routeSummary,
    routeDetail: routeDetailParts.join(' · '),
    routeReason: reasonParts.join(' · '),
    overrideSummary: overrideInsight.summary,
    overrideDetail: overrideInsight.detail,
    earlyExitSummary,
    earlyExitDetail,
  };
}

function buildEarlyExitInsight(
  taskResponse: Pick<TaskResponse, 'routeDecision' | 'reasonerResult' | 'pipeline'>,
): Pick<RoutingInsightView, 'earlyExitSummary' | 'earlyExitDetail'> {
  if (taskResponse.routeDecision.route === 'simple') {
    return {
      earlyExitSummary: 'Saved planner, reasoner, verifier',
      earlyExitDetail:
        taskResponse.reasonerResult?.earlyExitReason ??
        'Router chose simple path, so complex-only planner, reasoner, and verifier stages did not run.',
    };
  }

  if (taskResponse.reasonerResult?.status === 'skipped') {
    const skippedStages = taskResponse.pipeline.stages
      .filter((stage) => stage.state === 'skipped')
      .map((stage) => stage.label.toLowerCase())
      .filter((label, index, labels) => labels.indexOf(label) === index);

    return {
      earlyExitSummary: skippedStages.length > 0
        ? `Saved ${joinLabels(skippedStages)}`
        : 'Saved extra reasoning step',
      earlyExitDetail: taskResponse.reasonerResult.earlyExitReason ?? 'Reasoner exited early before executor.',
    };
  }

  const verifierStage = taskResponse.pipeline.stages.find((stage) => stage.stageId === 'verifier');
  if (verifierStage?.state === 'skipped') {
    return {
      earlyExitSummary: 'Verifier skipped',
      earlyExitDetail: verifierStage.skippedReason ?? 'Verifier stage skipped for current pipeline path.',
    };
  }

  return {
    earlyExitSummary: 'No early exit',
    earlyExitDetail: 'Pipeline ran full selected path before executor.',
  };
}

function joinLabels(labels: string[]): string {
  if (labels.length === 1) {
    return labels[0];
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}