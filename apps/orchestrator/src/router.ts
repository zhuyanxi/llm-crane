import {
  RouteDecisionSchema,
  type RouteDecision,
  type RouteScoreFactor,
  type RouteTier,
  type StructuredTask,
  type StructurizerResult,
} from '@llm-crane/schemas';

const SIMPLE_ROUTE_THRESHOLD = 4;

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function makeFactor(factor: string, score: number, detail: string): RouteScoreFactor {
  return {
    factor,
    score,
    detail,
  };
}

function summarizeStructuredTask(structuredTask: StructuredTask): string {
  return [
    `taskType=${structuredTask.taskType}`,
    `target=${structuredTask.target.kind}`,
    `quality=${structuredTask.qualityBar}`,
    `constraints=${structuredTask.constraints.length}`,
    `openQuestions=${structuredTask.openQuestions.length}`,
    `uncertainty=${structuredTask.uncertaintyReasons.length}`,
  ].join(' | ');
}

function buildComplexityFactors(result: StructurizerResult): RouteScoreFactor[] {
  const structuredTask = result.structuredTask;
  const factors: RouteScoreFactor[] = [];

  if (result.status === 'fallback') {
    factors.push(makeFactor('structurizer-status', 3, 'Structurizer already fell back; use safer path.'));
  }

  switch (structuredTask.taskType) {
    case 'debug':
    case 'analysis':
    case 'implementation':
      factors.push(makeFactor('task-type', 2, `${structuredTask.taskType} tasks usually need broader reasoning.`));
      break;
    case 'test':
      factors.push(makeFactor('task-type', 1, 'Test work often spans assertions and fixtures.'));
      break;
    case 'other':
      factors.push(makeFactor('task-type', 2, 'Unknown task type increases routing risk.'));
      break;
    default:
      factors.push(makeFactor('task-type', 0, 'Refactor task with narrow scope stays cheap by default.'));
      break;
  }

  switch (structuredTask.target.kind) {
    case 'workspace':
      factors.push(makeFactor('target-scope', 2, 'Workspace target expands scope across many files.'));
      break;
    case 'file':
      factors.push(makeFactor('target-scope', 1, 'File target is bounded but may still require broad edits.'));
      break;
    case 'unknown':
      factors.push(makeFactor('target-scope', 2, 'Unknown target makes cheap routing unsafe.'));
      break;
    default:
      factors.push(makeFactor('target-scope', 0, 'Selection or symbol target keeps scope narrow.'));
      break;
  }

  if (structuredTask.qualityBar === 'high') {
    factors.push(makeFactor('quality-bar', 2, 'High quality bar prefers more capable path.'));
  } else if (structuredTask.qualityBar === 'balanced') {
    factors.push(makeFactor('quality-bar', 1, 'Balanced quality bar allows moderate complexity budget.'));
  } else {
    factors.push(makeFactor('quality-bar', 0, 'Fast quality bar favors cheaper path.'));
  }

  if (structuredTask.constraints.length >= 4) {
    factors.push(makeFactor('constraints', 2, 'Many constraints increase routing complexity.'));
  } else if (structuredTask.constraints.length >= 2) {
    factors.push(makeFactor('constraints', 1, 'Some constraints need closer reasoning.'));
  } else {
    factors.push(makeFactor('constraints', 0, 'Constraint count stays low.'));
  }

  if (structuredTask.contextSummary.length >= 2) {
    factors.push(makeFactor('context-size', 1, 'Multiple attached contexts widen reasoning surface.'));
  } else {
    factors.push(makeFactor('context-size', 0, 'Context remains small.'));
  }

  if (structuredTask.openQuestions.length > 0) {
    factors.push(makeFactor('open-questions', 2, 'Open questions reduce confidence in cheap path.'));
  }

  if (structuredTask.uncertaintyReasons.length > 0) {
    factors.push(makeFactor('uncertainty', 2, 'Uncertainty markers push toward safer route.'));
  }

  return factors;
}

function buildRouteReason(route: RouteTier, factors: RouteScoreFactor[]): string {
  const topFactors = [...factors].sort((left, right) => right.score - left.score).slice(0, 3);

  if (route === 'simple') {
    const simpleSignals = unique(
      topFactors
        .filter((factor) => factor.score === 0)
        .map((factor) => factor.detail),
    );

    return simpleSignals[0] ?? 'Low complexity score with narrow scope; use cheaper path.';
  }

  return unique(topFactors.map((factor) => factor.detail)).join(' ');
}

function inferRouteDecision(result: StructurizerResult): unknown {
  const scoreBreakdown = buildComplexityFactors(result);
  const complexityScore = scoreBreakdown.reduce((sum, factor) => sum + factor.score, 0);
  const route: RouteTier = complexityScore >= SIMPLE_ROUTE_THRESHOLD ? 'complex' : 'simple';
  const distanceFromThreshold = Math.abs(complexityScore - SIMPLE_ROUTE_THRESHOLD);
  const confidence = route === 'simple'
    ? clampConfidence(0.62 + distanceFromThreshold * 0.08)
    : clampConfidence(0.58 + distanceFromThreshold * 0.07);

  return {
    status: 'routed',
    route,
    reason: buildRouteReason(route, scoreBreakdown),
    confidence,
    complexityScore,
    scoreBreakdown,
    strategy: 'rules-v1',
  };
}

export function buildRouterScoreInput(result: StructurizerResult): string {
  return [
    'Router scoring input',
    summarizeStructuredTask(result.structuredTask),
    `structurizerStatus=${result.status}`,
    `warnings=${result.warnings.join(' | ') || 'none'}`,
  ].join('\n');
}

export function createSafeFallbackRouteDecision(reason: string): RouteDecision {
  return RouteDecisionSchema.parse({
    status: 'fallback',
    route: 'complex',
    reason: 'Router fell back to safer complex path.',
    confidence: 0.2,
    complexityScore: 12,
    scoreBreakdown: [
      {
        factor: 'router-fallback',
        score: 4,
        detail: reason,
      },
    ],
    strategy: 'safe-fallback',
    fallbackReason: reason,
  });
}

export function parseRouteDecision(candidate: unknown): RouteDecision {
  try {
    const parsed = RouteDecisionSchema.parse(candidate);
    if (parsed.status === 'fallback' && !parsed.fallbackReason) {
      return RouteDecisionSchema.parse({
        ...parsed,
        fallbackReason: 'Router chose safe fallback path.',
      });
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown router parse error.';
    return createSafeFallbackRouteDecision(`Router output invalid: ${reason}`);
  }
}

export function routeTask(result: StructurizerResult): RouteDecision {
  return parseRouteDecision(inferRouteDecision(result));
}