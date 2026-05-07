import {
  ReasonerInputSchema,
  ReasonerResultSchema,
  type PlannerResult,
  type ReasonerDecisionSource,
  type ReasonerInput,
  type ReasonerResult,
  type RouteDecision,
  type StructuredTask,
  type StructurizerResult,
  type TaskRequest,
} from '@llm-crane/schemas';

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength = 140): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))];
}

function summarizeTarget(structuredTask: StructuredTask): string {
  switch (structuredTask.target.kind) {
    case 'selection':
      return 'current selection';
    case 'file':
      return structuredTask.target.uri ?? structuredTask.target.value;
    case 'symbol':
      return `symbol ${structuredTask.target.value}`;
    case 'workspace':
      return 'current workspace';
    default:
      return structuredTask.target.value;
  }
}

function determineDecisionSource(routerSignals: string[], plannerSignals: string[]): ReasonerDecisionSource {
  if (routerSignals.length > 0 && plannerSignals.length > 0) {
    return 'router+planner';
  }

  if (routerSignals.length > 0) {
    return 'router';
  }

  return 'planner';
}

function collectRouterSignals(
  taskRequest: TaskRequest,
  structuredTask: StructuredTask,
  routeDecision: RouteDecision,
): string[] {
  if (routeDecision.route !== 'complex') {
    return [];
  }

  return unique([
    routeDecision.status === 'fallback' ? 'Router fallback lowered routing confidence and kept the task on the conservative complex path.' : '',
    routeDecision.complexityScore >= 8
      ? `Router complexity score ${routeDecision.complexityScore} indicates the task spans multiple moving parts.`
      : '',
    structuredTask.target.kind === 'workspace' ? 'Workspace-wide scope requires cross-file synthesis before execution.' : '',
    taskRequest.qualityBar === 'high' && (structuredTask.taskType === 'analysis' || structuredTask.taskType === 'debug')
      ? `High-quality ${structuredTask.taskType} request benefits from stronger synthesis before answering.`
      : '',
  ]);
}

function collectPlannerSignals(plannerResult?: PlannerResult): string[] {
  if (!plannerResult) {
    return [];
  }

  return unique([
    plannerResult.status === 'fallback' ? 'Planner entered fallback mode, so downstream reasoning should stay conservative and explicit.' : '',
    plannerResult.openQuestions.length > 0
      ? `Planner kept ${plannerResult.openQuestions.length} open question(s) explicit for downstream handling.`
      : '',
    plannerResult.decisionPoints.length >= 2
      ? `Planner identified ${plannerResult.decisionPoints.length} decision points that still need ranking.`
      : '',
    plannerResult.downstreamHints.reasonerFocus[0]
      ? `Planner requested extra reasoning on ${truncate(plannerResult.downstreamHints.reasonerFocus[0])}.`
      : '',
  ]);
}

function buildKeyContext(structuredTask: StructuredTask, plannerResult?: PlannerResult): string[] {
  return unique([
    `Task type: ${structuredTask.taskType}`,
    `Target: ${summarizeTarget(structuredTask)}`,
    `Attached context refs: ${structuredTask.contextSummary.length}`,
    ...structuredTask.contextSummary.slice(0, 3).map((context) => `Context ref: ${truncate(context)}`),
    ...structuredTask.uncertaintyReasons.slice(0, 2).map((reason) => `Uncertainty: ${truncate(reason)}`),
    plannerResult ? `Planner steps: ${plannerResult.steps.length}` : '',
  ]).slice(0, 6);
}

function buildDecisionPoints(plannerResult?: PlannerResult): string[] {
  if (!plannerResult) {
    return [];
  }

  return unique(plannerResult.decisionPoints.map((decisionPoint) => truncate(decisionPoint.question))).slice(0, 4);
}

function buildPlannerFocus(plannerResult?: PlannerResult): string[] {
  if (!plannerResult) {
    return [];
  }

  return unique(plannerResult.downstreamHints.reasonerFocus.map((focus) => truncate(focus))).slice(0, 4);
}

export function buildReasonerInput(
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
  plannerResult?: PlannerResult,
): ReasonerInput {
  const structuredTask = structurizerResult.structuredTask;
  const target = summarizeTarget(structuredTask);

  if (routeDecision.route === 'simple') {
    return ReasonerInputSchema.parse({
      taskType: structuredTask.taskType,
      qualityBar: taskRequest.qualityBar,
      target,
      routeReason: routeDecision.reason,
      needReasoning: false,
      decisionSource: 'router',
      earlyExitReason: 'Router chose the simple path, so extra reasoning would be redundant.',
      keyContext: buildKeyContext(structuredTask, plannerResult),
      criticalConstraints: structuredTask.constraints.slice(0, 3).map((constraint) => truncate(constraint)),
      decisionPoints: buildDecisionPoints(plannerResult),
      plannerFocus: buildPlannerFocus(plannerResult),
    });
  }

  const routerSignals = collectRouterSignals(taskRequest, structuredTask, routeDecision);
  const plannerSignals = collectPlannerSignals(plannerResult);
  const needReasoning = routerSignals.length + plannerSignals.length > 0;
  const decisionSource = determineDecisionSource(routerSignals, plannerSignals);
  const escalationSignals = unique([...routerSignals, ...plannerSignals]);

  return ReasonerInputSchema.parse({
    taskType: structuredTask.taskType,
    qualityBar: taskRequest.qualityBar,
    target,
    routeReason: routeDecision.reason,
    needReasoning,
    decisionSource,
    escalationReason: needReasoning ? escalationSignals[0] : undefined,
    earlyExitReason: needReasoning
      ? undefined
      : `Planner found a bounded ${structuredTask.taskType} path for ${target}, so executor can proceed without extra reasoning.`,
    keyContext: buildKeyContext(structuredTask, plannerResult),
    criticalConstraints: structuredTask.constraints.slice(0, 3).map((constraint) => truncate(constraint)),
    decisionPoints: buildDecisionPoints(plannerResult),
    plannerFocus: buildPlannerFocus(plannerResult),
  });
}

function buildSkippedEvidence(reasonerInput: ReasonerInput): string[] {
  return unique([
    reasonerInput.keyContext[0] ?? '',
    reasonerInput.keyContext[1] ?? '',
    reasonerInput.decisionPoints.length === 0 ? 'Planner left no unresolved decision points.' : '',
    reasonerInput.plannerFocus.length === 0 ? 'Planner did not request extra reasoning.' : '',
    reasonerInput.criticalConstraints[0] ? `Primary constraint: ${reasonerInput.criticalConstraints[0]}` : '',
  ]).slice(0, 4);
}

export function createSkippedReasonerResult(reasonerInput: ReasonerInput): ReasonerResult {
  return ReasonerResultSchema.parse({
    status: 'skipped',
    needReasoning: false,
    decisionSource: reasonerInput.decisionSource,
    earlyExitReason: reasonerInput.earlyExitReason ?? 'Reasoner not required for this task.',
    summary: `Early exit: executor can proceed without extra reasoning for ${reasonerInput.taskType} on ${reasonerInput.target}.`,
    keyEvidence: buildSkippedEvidence(reasonerInput),
  });
}

function inferReasonerCandidate(reasonerInput: ReasonerInput): unknown {
  return {
    status: 'reasoned',
    needReasoning: true,
    decisionSource: reasonerInput.decisionSource,
    escalationReason: reasonerInput.escalationReason,
    summary: `Escalate reasoning for ${reasonerInput.taskType} on ${reasonerInput.target}: ${reasonerInput.escalationReason ?? 'additional synthesis is required before execution.'}`,
    keyEvidence: unique([
      ...reasonerInput.keyContext.slice(0, 2),
      ...reasonerInput.criticalConstraints.slice(0, 2).map((constraint) => `Constraint: ${constraint}`),
      ...reasonerInput.decisionPoints.slice(0, 2).map((decisionPoint) => `Decision point: ${decisionPoint}`),
      ...reasonerInput.plannerFocus.slice(0, 2).map((focus) => `Focus: ${focus}`),
    ]).slice(0, 6),
  };
}

export function createFallbackReasonerResult(reasonerInput: ReasonerInput, reason: string): ReasonerResult {
  return ReasonerResultSchema.parse({
    status: 'fallback',
    needReasoning: reasonerInput.needReasoning,
    decisionSource: reasonerInput.decisionSource,
    escalationReason: reasonerInput.escalationReason,
    earlyExitReason: reasonerInput.needReasoning ? undefined : reasonerInput.earlyExitReason,
    summary: `Reasoner fallback for ${reasonerInput.taskType} on ${reasonerInput.target}.`,
    keyEvidence: unique([
      reasonerInput.keyContext[0] ?? '',
      reasonerInput.escalationReason ? `Escalation: ${reasonerInput.escalationReason}` : '',
      `Fallback: ${truncate(reason)}`,
    ]).slice(0, 4),
    warnings: [reason],
    fallbackReason: reason,
  });
}

export function parseReasonerOutput(candidate: unknown, reasonerInput: ReasonerInput): ReasonerResult {
  try {
    return ReasonerResultSchema.parse(candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown reasoner parse error.';
    return createFallbackReasonerResult(reasonerInput, `Reasoner output invalid: ${reason}`);
  }
}

export function reasonTask(reasonerInput: ReasonerInput): ReasonerResult {
  if (!reasonerInput.needReasoning) {
    return createSkippedReasonerResult(reasonerInput);
  }

  return parseReasonerOutput(inferReasonerCandidate(reasonerInput), reasonerInput);
}