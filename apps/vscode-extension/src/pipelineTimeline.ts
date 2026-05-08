import type {
  PipelineExecutionState,
  PipelineStageId,
  PipelineStageState,
  PipelineTraceEvent,
  TaskResponse,
} from '@llm-crane/schemas';

const PIPELINE_STAGE_IDS: PipelineStageId[] = [
  'request',
  'structurizer',
  'router',
  'planner',
  'reasoner',
  'verifier',
  'executor',
  'response',
];

export type TaskTimelineStageView = {
  stageId: PipelineStageId;
  label: string;
  state: PipelineExecutionState;
  statusLabel: string;
  duration: string;
  summary: string;
  detail: string;
  error?: string;
};

export function buildPipelineTimeline(taskResponse: Pick<TaskResponse, 'pipeline' | 'trace'>): TaskTimelineStageView[] {
  const traceByStage = groupTraceEventsByStage(taskResponse.trace);

  return taskResponse.pipeline.stages.map((stage) => {
    const stageTrace = traceByStage.get(stage.stageId) ?? [];

    return {
      stageId: stage.stageId,
      label: stage.label,
      state: stage.state,
      statusLabel: formatStateLabel(stage.state),
      duration: formatStageDuration(stage),
      summary: buildStageSummary(stage),
      detail: buildStageDetail(stage, stageTrace),
      error: buildStageError(stage, stageTrace),
    };
  });
}

function isPipelineStageId(value: string): value is PipelineStageId {
  return PIPELINE_STAGE_IDS.includes(value as PipelineStageId);
}

function groupTraceEventsByStage(trace: PipelineTraceEvent[]): Map<PipelineStageId, PipelineTraceEvent[]> {
  const grouped = new Map<PipelineStageId, PipelineTraceEvent[]>();

  for (const event of trace) {
    const stageId = normalizeTraceStage(event.stage);
    if (!stageId) {
      continue;
    }

    const entries = grouped.get(stageId) ?? [];
    entries.push(event);
    grouped.set(stageId, entries);
  }

  return grouped;
}

function normalizeTraceStage(stage: string): PipelineStageId | undefined {
  const [prefix] = stage.split('.', 1);
  return prefix && isPipelineStageId(prefix) ? prefix : undefined;
}

function formatStateLabel(state: PipelineExecutionState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatStageDuration(stage: PipelineStageState): string {
  if (!stage.startedAt) {
    return stage.state === 'pending' ? 'Not started' : 'No timing';
  }

  if (!stage.completedAt) {
    return 'In progress';
  }

  const durationMs = Math.max(0, Date.parse(stage.completedAt) - Date.parse(stage.startedAt));
  return formatDuration(durationMs);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  if (durationMs < 60_000) {
    const seconds = durationMs / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)} s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatConfidence(confidence: number | undefined): string | undefined {
  if (confidence === undefined) {
    return undefined;
  }

  return `${Math.round(confidence * 100)}% confidence`;
}

function buildStageSummary(stage: PipelineStageState): string {
  const output = stage.output;
  if (!output) {
    if (stage.state === 'skipped' && stage.skippedReason) {
      return stage.skippedReason;
    }

    if (stage.state === 'failed') {
      return 'Stage failed before summary output.';
    }

    if (stage.state === 'pending') {
      return 'Stage not started.';
    }

    if (stage.state === 'running') {
      return 'Stage running.';
    }

    return 'Stage completed.';
  }

  switch (output.stageId) {
    case 'request':
      return 'Task request accepted.';
    case 'structurizer': {
      const parts = [`${output.status} ${output.taskType}`, `target=${output.targetKind}`];
      if (output.expectedOutputCount !== undefined) {
        parts.push(`expected=${output.expectedOutputCount}`);
      }
      const confidence = formatConfidence(output.confidence);
      if (confidence) {
        parts.push(confidence);
      }
      if (output.warningCount > 0) {
        parts.push(`warnings=${output.warningCount}`);
      }
      return parts.join(' · ');
    }
    case 'router': {
      const parts = [`${output.route} route`, `score=${output.complexityScore}`];
      const confidence = formatConfidence(output.confidence);
      if (confidence) {
        parts.push(confidence);
      }
      if (output.fallbackReason) {
        parts.push('fallback');
      }
      return parts.join(' · ');
    }
    case 'planner':
      return `${output.summary} · steps=${output.planStepCount} · decisions=${output.decisionPointCount}`;
    case 'reasoner':
      return `${output.summary} · needReasoning=${output.needReasoning} · evidence=${output.keyEvidenceCount}`;
    case 'verifier':
      return `${output.verificationStatus} · ${output.detail}`;
    case 'executor':
      return `${output.status} · ${output.providerId}/${output.modelId}${output.latencyMs !== undefined ? ` · ${output.latencyMs} ms` : ''}`;
    case 'response':
      return `${output.providerStatus} · output=${output.outputChars} chars · cost=${output.costStatus}`;
  }
}

function buildStageDetail(stage: PipelineStageState, trace: PipelineTraceEvent[]): string {
  const latestTrace = trace.at(-1);
  const details: string[] = [];

  if (stage.skippedReason && stage.state === 'skipped') {
    details.push(stage.skippedReason);
  } else if (latestTrace?.detail) {
    details.push(latestTrace.detail);
  }

  if (stage.dependsOn.length > 0) {
    details.push(`Depends on ${stage.dependsOn.join(', ')}`);
  }

  if (trace.length > 0) {
    details.push(`${trace.length} trace event${trace.length === 1 ? '' : 's'}`);
  }

  return details.join(' · ') || 'No additional stage detail.';
}

function buildStageError(stage: PipelineStageState, trace: PipelineTraceEvent[]): string | undefined {
  if (stage.error) {
    return `${stage.error.code}: ${stage.error.message}`;
  }

  const traceError = [...trace].reverse().find((event) => event.error)?.error;
  if (traceError) {
    return `${traceError.code}: ${traceError.message}`;
  }

  if (stage.output?.stageId === 'executor' && stage.output.errorCode) {
    return stage.output.errorCode;
  }

  return undefined;
}