import type { TaskResponse } from '@llm-crane/schemas';
import { describeTaskModelOverride } from './modelOverride';

type TaskHistorySource = Pick<
  TaskResponse,
  'routeDecision' | 'selectedProvider' | 'runInfo' | 'cacheInfo' | 'providerResult' | 'diagnostic' | 'checkpoint' | 'trace' | 'verifierResult'
>;

export type TaskHistoryEntryView = {
  id: string;
  title: string;
  summary: string;
  detail: string;
  tags: string[];
  capturedAt: string;
};

export function buildTaskHistoryEntryView(
  id: string,
  submittedTask: string,
  taskResponse: TaskHistorySource,
): TaskHistoryEntryView {
  const override = describeTaskModelOverride(
    taskResponse.checkpoint.taskRequest.policyOverrides,
    taskResponse.selectedProvider.modelId,
  );
  const tags = [
    taskResponse.routeDecision.route,
    formatCacheTag(taskResponse),
    formatRunTag(taskResponse),
    ...(override.summary === 'Automatic routing' ? [] : ['override']),
    ...(taskResponse.trace.some((traceEvent) => traceEvent.stage === 'executor.fallback') ? ['fallback'] : []),
    ...(taskResponse.verifierResult && taskResponse.verifierResult.verdict !== 'pass'
      ? [`verify:${taskResponse.verifierResult.verdict}`]
      : []),
    ...(taskResponse.providerResult.status === 'failed' || taskResponse.diagnostic || taskResponse.verifierResult?.verdict === 'fail'
      ? ['failed']
      : []),
  ];

  return {
    id,
    title: summarizeTask(submittedTask),
    summary: `${taskResponse.routeDecision.route} route · ${taskResponse.selectedProvider.providerId}/${taskResponse.selectedProvider.modelId}`,
    detail: `trace=${taskResponse.trace.length} · ${taskResponse.runInfo.mode === 'stage-rerun'
      ? `rerun from ${taskResponse.runInfo.targetStageId}`
      : 'full run'} · ${override.summary}`,
    tags,
    capturedAt: taskResponse.checkpoint.capturedAt,
  };
}

function summarizeTask(task: string): string {
  const normalized = task.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return 'Untitled task';
  }

  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69)}...`;
}

function formatCacheTag(taskResponse: TaskHistorySource): string {
  return `cache:${taskResponse.cacheInfo?.status ?? 'unknown'}`;
}

function formatRunTag(taskResponse: TaskHistorySource): string {
  return taskResponse.runInfo.mode === 'stage-rerun'
    ? `rerun:${taskResponse.runInfo.targetStageId}`
    : 'full';
}