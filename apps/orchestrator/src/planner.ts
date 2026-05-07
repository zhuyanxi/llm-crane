import { PLANNER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import {
  PlannerResultSchema,
  type PlanDecisionPoint,
  type PlanStep,
  type PlannerResult,
  type RouteDecision,
  type StructuredTask,
  type StructurizerResult,
  type TaskRequest,
} from '@llm-crane/schemas';

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function makePlanStep(stepId: string, title: string, objective: string, acceptance: string): PlanStep {
  return {
    stepId,
    title,
    objective,
    acceptance,
  };
}

function buildAnalysisStep(structuredTask: StructuredTask): PlanStep {
  const targetSummary = summarizeTarget(structuredTask);

  switch (structuredTask.taskType) {
    case 'debug':
      return makePlanStep(
        'analyze-failure',
        'Analyze failure path',
        `Trace likely failure path in ${targetSummary} and isolate root-cause candidates before proposing fix.`,
        'Response explains failure mechanism or missing evidence instead of guessing.',
      );
    case 'implementation':
      return makePlanStep(
        'design-change',
        'Design minimal change',
        `Outline smallest implementation slice for ${targetSummary}, including affected files, interfaces, and constraints.`,
        'Response names intended change slice and keeps requested scope bounded.',
      );
    case 'test':
      return makePlanStep(
        'map-test-surface',
        'Map test surface',
        `Identify behavior to assert in ${targetSummary} and note fixtures, mocks, or regressions that matter.`,
        'Response names concrete assertions or validation path.',
      );
    case 'refactor':
      return makePlanStep(
        'map-refactor',
        'Map refactor boundaries',
        `Identify duplication, coupling, or structure issues inside ${targetSummary} and choose least risky refactor path.`,
        'Response names safe refactor boundary and preserves requested contracts.',
      );
    default:
      return makePlanStep(
        'survey-target',
        'Survey target and risks',
        `Inspect ${targetSummary} and identify main change or analysis surface before final answer.`,
        'Response names key files, symbols, or risk areas that drive final answer.',
      );
  }
}

function buildPlanSteps(taskRequest: TaskRequest, structuredTask: StructuredTask): PlanStep[] {
  const targetSummary = summarizeTarget(structuredTask);
  const steps: PlanStep[] = [
    makePlanStep(
      'inspect-context',
      'Inspect context and target',
      `Review attached contexts, explicit constraints, and target scope for ${targetSummary}.`,
      'Response reflects provided context and keeps mandatory constraints visible.',
    ),
    buildAnalysisStep(structuredTask),
  ];

  if (structuredTask.openQuestions.length > 0) {
    steps.push(
      makePlanStep(
        'surface-open-questions',
        'Handle missing details conservatively',
        'Resolve what can be inferred safely and surface remaining open questions instead of inventing facts.',
        'Response separates known facts from assumptions and highlights unresolved questions.',
      ),
    );
  }

  steps.push(
    makePlanStep(
      'deliver-answer',
      'Deliver bounded final answer',
      `Produce final response for task "${normalizeText(taskRequest.task)}" with explicit risks, assumptions, and next validation step when needed.`,
      'Final answer stays within requested story and calls out validation or blockers.',
    ),
  );

  return steps;
}

function buildDecisionPoints(taskRequest: TaskRequest, structuredTask: StructuredTask, routeDecision: RouteDecision): PlanDecisionPoint[] {
  const decisionPoints: PlanDecisionPoint[] = [];

  if (structuredTask.openQuestions.length > 0) {
    decisionPoints.push({
      question: structuredTask.openQuestions[0],
      whyItMatters: 'Missing task details can widen scope or weaken final answer quality.',
      options: ['Proceed conservatively with stated assumptions', 'Ask user for clarification before deep changes'],
      defaultChoice: 'Proceed conservatively with stated assumptions',
    });
  }

  if (structuredTask.constraints.length > 0) {
    decisionPoints.push({
      question: 'Which constraint should dominate when tradeoffs conflict?',
      whyItMatters: 'Complex task may require choosing between speed, scope, and contract stability.',
      options: [structuredTask.constraints[0], 'Keep current scope even if answer stays partial'],
      defaultChoice: structuredTask.constraints[0],
    });
  }

  if (routeDecision.status === 'fallback') {
    decisionPoints.push({
      question: 'Should planner stay conservative because upstream routing confidence is low?',
      whyItMatters: 'Router fallback already marked task as higher risk.',
      options: ['Yes, keep conservative plan', 'No, take broader speculative path'],
      defaultChoice: 'Yes, keep conservative plan',
    });
  }

  return decisionPoints;
}

function buildDownstreamHints(structuredTask: StructuredTask): PlannerResult['downstreamHints'] {
  const reasonerFocus = unique([
    structuredTask.taskType === 'debug' ? 'Verify root cause before proposing fix.' : '',
    structuredTask.taskType === 'analysis' ? 'Compare top risks and rank by impact.' : '',
    structuredTask.openQuestions.length > 0 ? 'Keep missing details explicit and avoid speculation.' : '',
    structuredTask.target.kind === 'workspace' ? 'Compress workspace context to key files and interfaces.' : '',
  ]);

  const verifierChecks = unique([
    ...structuredTask.constraints.map((constraint) => `Check constraint: ${constraint}`),
    structuredTask.taskType === 'implementation' ? 'Confirm minimal requested change only.' : '',
    structuredTask.taskType === 'refactor' ? 'Confirm behavior and public API stay stable.' : '',
    structuredTask.taskType === 'test' ? 'Confirm proposed tests cover regression path.' : '',
  ]);

  return {
    reasonerFocus,
    verifierChecks,
  };
}

function inferPlannerCandidate(taskRequest: TaskRequest, structurizerResult: StructurizerResult, routeDecision: RouteDecision): unknown {
  const structuredTask = structurizerResult.structuredTask;
  const steps = buildPlanSteps(taskRequest, structuredTask);
  const decisionPoints = buildDecisionPoints(taskRequest, structuredTask, routeDecision);
  const downstreamHints = buildDownstreamHints(structuredTask);
  const shouldFallback = structurizerResult.status === 'fallback' || routeDecision.status === 'fallback';
  const summaryPrefix = shouldFallback ? 'Conservative plan' : 'Execution plan';

  return {
    status: shouldFallback ? 'fallback' : 'planned',
    summary: `${summaryPrefix} for ${structuredTask.taskType} task on ${summarizeTarget(structuredTask)} with ${steps.length} ordered steps.`,
    steps,
    decisionPoints,
    openQuestions: structuredTask.openQuestions,
    downstreamHints,
    warnings: unique([
      ...structurizerResult.warnings,
      shouldFallback ? 'Planner chose conservative fallback because upstream confidence is reduced.' : '',
    ]),
    fallbackReason: shouldFallback
      ? unique([structurizerResult.fallbackReason ?? '', routeDecision.fallbackReason ?? '']).join(' | ') || 'Planner chose conservative fallback.'
      : undefined,
  };
}

export function buildPlannerPrompt(
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
): string {
  return [
    PLANNER_SYSTEM_PROMPT,
    `Task: ${normalizeText(taskRequest.task)}`,
    `Structured task: ${JSON.stringify(structurizerResult.structuredTask, null, 2)}`,
    `Route decision: ${JSON.stringify(routeDecision, null, 2)}`,
    `Context count: ${taskRequest.contexts.length}`,
  ].join('\n\n');
}

export function createFallbackPlannerResult(
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
  reason: string,
): PlannerResult {
  const structuredTask = structurizerResult.structuredTask;

  return PlannerResultSchema.parse({
    status: 'fallback',
    summary: `Planner fallback for ${structuredTask.taskType} task on ${summarizeTarget(structuredTask)}.`,
    steps: [
      makePlanStep(
        'inspect-context',
        'Inspect known context',
        'Use only attached context and explicit constraints as trusted inputs.',
        'Final answer references only observed context or clearly marked assumptions.',
      ),
      makePlanStep(
        'answer-conservatively',
        'Answer conservatively',
        `Provide bounded response for task "${normalizeText(taskRequest.task)}" without expanding scope.`,
        'Final answer stays partial rather than speculative if information is missing.',
      ),
      makePlanStep(
        'surface-risks',
        'Surface blockers and next validation',
        'Call out unresolved questions, main risks, and smallest useful validation step.',
        'Final answer contains blockers or validation guidance when certainty is low.',
      ),
    ],
    decisionPoints: buildDecisionPoints(taskRequest, structuredTask, routeDecision),
    openQuestions: structuredTask.openQuestions,
    downstreamHints: buildDownstreamHints(structuredTask),
    warnings: unique([...structurizerResult.warnings, 'Planner fallback path active.']),
    fallbackReason: reason,
  });
}

export function parsePlannerOutput(
  candidate: unknown,
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
): PlannerResult {
  try {
    const parsed = PlannerResultSchema.parse(candidate);

    if (parsed.status === 'fallback' && !parsed.fallbackReason) {
      return PlannerResultSchema.parse({
        ...parsed,
        fallbackReason: 'Planner chose conservative fallback path.',
      });
    }

    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown planner parse error.';
    return createFallbackPlannerResult(
      taskRequest,
      structurizerResult,
      routeDecision,
      `Planner output invalid: ${reason}`,
    );
  }
}

export function planTask(
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
): PlannerResult {
  return parsePlannerOutput(
    inferPlannerCandidate(taskRequest, structurizerResult, routeDecision),
    taskRequest,
    structurizerResult,
    routeDecision,
  );
}