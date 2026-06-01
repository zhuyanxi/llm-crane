import { ROUTER_ASSISTANT_SYSTEM_PROMPT } from '@llm-crane/prompts';
import { ProviderInvocationError, type ProviderInvocationRequest } from '@llm-crane/providers';
import {
  RouteAssistantResultSchema,
  RouteDecisionSchema,
  RouteScoringConfigSchema,
  type RouteAssistantResult,
  type RouteDecision,
  type RouteScoreDimension,
  type RouteScoreFactor,
  type RouteScoringConfig,
  type RouteTier,
  type StructuredTask,
  type StructurizerResult,
} from '@llm-crane/schemas';

export const DEFAULT_ROUTE_SCORING_CONFIG: RouteScoringConfig = RouteScoringConfigSchema.parse({});

const ROUTER_ASSISTANT_MAX_OUTPUT_TOKENS = 600;
const ROUTER_ASSISTANT_TIMEOUT_MS = 8_000;
const ROUTER_ASSISTANT_HYBRID_WEIGHT = 0.35;

type BudgetPreference = 'save-cost' | 'balanced' | 'best-quality';

const BUDGET_SCORING_OVERRIDES: Record<BudgetPreference, Pick<RouteScoringConfig, 'budgetPressureWeight' | 'complexThreshold'>> = {
  'save-cost': { budgetPressureWeight: 0.35, complexThreshold: 6 },
  balanced: { budgetPressureWeight: 0.15, complexThreshold: 4 },
  'best-quality': { budgetPressureWeight: 0.05, complexThreshold: 2 },
};

function resolveBudgetAwareScoringConfig(
  config: RouteScoringConfig,
  budgetPreference?: BudgetPreference,
): RouteScoringConfig {
  if (!budgetPreference || budgetPreference === 'balanced') {
    return config;
  }

  const overrides = BUDGET_SCORING_OVERRIDES[budgetPreference];

  return resolveRouteScoringConfig({
    ...config,
    ...overrides,
  });
}

function detectBudgetConflict(
  result: StructurizerResult,
  budgetPreference?: BudgetPreference,
): string | undefined {
  if (budgetPreference !== 'save-cost') {
    return undefined;
  }

  if (result.structuredTask.qualityBar === 'high') {
    return 'Budget preference "save-cost" conflicts with "high" quality bar. Task will stay on cheaper route but may produce weaker results.';
  }

  if (result.structuredTask.target.kind === 'workspace') {
    return 'Budget preference "save-cost" may skip workspace-wide analysis needed for accurate result.';
  }

  return undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(20, Math.round(value)));
}

function makeFactor(dimension: RouteScoreDimension, factor: string, score: number, detail: string): RouteScoreFactor {
  return {
    factor,
    dimension,
    score,
    detail,
  };
}

function resolveRouteScoringConfig(config?: Partial<RouteScoringConfig>): RouteScoringConfig {
  const resolvedConfig = RouteScoringConfigSchema.parse({
    ...DEFAULT_ROUTE_SCORING_CONFIG,
    ...config,
  });
  const weightTotal = resolvedConfig.complexityWeight + resolvedConfig.riskWeight + resolvedConfig.budgetPressureWeight;

  if (weightTotal <= 0) {
    return DEFAULT_ROUTE_SCORING_CONFIG;
  }

  return {
    ...resolvedConfig,
    complexityWeight: Number((resolvedConfig.complexityWeight / weightTotal).toFixed(3)),
    riskWeight: Number((resolvedConfig.riskWeight / weightTotal).toFixed(3)),
    budgetPressureWeight: Number((resolvedConfig.budgetPressureWeight / weightTotal).toFixed(3)),
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
    factors.push(makeFactor('complexity', 'structurizer-status', 3, 'Structurizer already fell back; use safer path.'));
  }

  switch (structuredTask.taskType) {
    case 'debug':
    case 'analysis':
    case 'implementation':
      factors.push(makeFactor('complexity', 'task-type', 2, `${structuredTask.taskType} tasks usually need broader reasoning.`));
      break;
    case 'test':
      factors.push(makeFactor('complexity', 'task-type', 1, 'Test work often spans assertions and fixtures.'));
      break;
    case 'other':
      factors.push(makeFactor('complexity', 'task-type', 2, 'Unknown task type increases routing risk.'));
      break;
    default:
      factors.push(makeFactor('complexity', 'task-type', 0, 'Refactor task with narrow scope stays cheap by default.'));
      break;
  }

  switch (structuredTask.target.kind) {
    case 'workspace':
      factors.push(makeFactor('complexity', 'target-scope', 2, 'Workspace target expands scope across many files.'));
      break;
    case 'file':
      factors.push(makeFactor('complexity', 'target-scope', 1, 'File target is bounded but may still require broad edits.'));
      break;
    case 'unknown':
      factors.push(makeFactor('complexity', 'target-scope', 2, 'Unknown target makes cheap routing unsafe.'));
      break;
    default:
      factors.push(makeFactor('complexity', 'target-scope', 0, 'Selection or symbol target keeps scope narrow.'));
      break;
  }

  if (structuredTask.qualityBar === 'high') {
    factors.push(makeFactor('complexity', 'quality-bar', 2, 'High quality bar prefers more capable path.'));
  } else if (structuredTask.qualityBar === 'balanced') {
    factors.push(makeFactor('complexity', 'quality-bar', 1, 'Balanced quality bar allows moderate complexity budget.'));
  } else {
    factors.push(makeFactor('complexity', 'quality-bar', 0, 'Fast quality bar favors cheaper path.'));
  }

  if (structuredTask.constraints.length >= 4) {
    factors.push(makeFactor('complexity', 'constraints', 2, 'Many constraints increase routing complexity.'));
  } else if (structuredTask.constraints.length >= 2) {
    factors.push(makeFactor('complexity', 'constraints', 1, 'Some constraints need closer reasoning.'));
  } else {
    factors.push(makeFactor('complexity', 'constraints', 0, 'Constraint count stays low.'));
  }

  if (structuredTask.contextSummary.length >= 2) {
    factors.push(makeFactor('complexity', 'context-size', 1, 'Multiple attached contexts widen reasoning surface.'));
  } else {
    factors.push(makeFactor('complexity', 'context-size', 0, 'Context remains small.'));
  }

  if (structuredTask.openQuestions.length > 0) {
    factors.push(makeFactor('complexity', 'open-questions', 2, 'Open questions reduce confidence in cheap path.'));
  }

  if (structuredTask.uncertaintyReasons.length > 0) {
    factors.push(makeFactor('complexity', 'uncertainty', 2, 'Uncertainty markers push toward safer route.'));
  }

  return factors;
}

function buildRiskFactors(result: StructurizerResult): RouteScoreFactor[] {
  const structuredTask = result.structuredTask;
  const factors: RouteScoreFactor[] = [];

  if (result.status === 'fallback') {
    factors.push(makeFactor('risk', 'structurizer-fallback', 4, 'Structurizer fallback means router should avoid cheap uncertain route.'));
  }

  if (structuredTask.target.kind === 'workspace' || structuredTask.target.kind === 'unknown') {
    factors.push(makeFactor('risk', 'target-risk', 3, `${structuredTask.target.kind} target raises missed-scope risk.`));
  } else if (structuredTask.target.kind === 'file') {
    factors.push(makeFactor('risk', 'target-risk', 1, 'File target carries moderate integration risk.'));
  } else {
    factors.push(makeFactor('risk', 'target-risk', 0, 'Selection or symbol target limits blast radius.'));
  }

  if (structuredTask.openQuestions.length > 0) {
    factors.push(makeFactor('risk', 'open-questions', 3, 'Open questions make confident cheap routing risky.'));
  }

  if (structuredTask.uncertaintyReasons.length > 0) {
    factors.push(makeFactor('risk', 'uncertainty', 3, 'Uncertainty reasons indicate hidden requirements.'));
  }

  if (structuredTask.constraints.length >= 4) {
    factors.push(makeFactor('risk', 'constraint-risk', 2, 'Many constraints increase chance of missing a hard rule.'));
  } else if (structuredTask.constraints.length >= 2) {
    factors.push(makeFactor('risk', 'constraint-risk', 1, 'Some constraints require extra checking.'));
  }

  if (structuredTask.taskType === 'debug' || structuredTask.taskType === 'analysis') {
    factors.push(makeFactor('risk', 'task-risk', 2, `${structuredTask.taskType} task benefits from stronger evidence synthesis.`));
  }

  return factors;
}

function buildBudgetPressureFactors(result: StructurizerResult): RouteScoreFactor[] {
  const structuredTask = result.structuredTask;
  const contextSummaryText = structuredTask.contextSummary.join(' ').toLowerCase();
  const factors: RouteScoreFactor[] = [];

  if (structuredTask.qualityBar === 'high') {
    factors.push(makeFactor('budget-pressure', 'quality-cost', 3, 'High quality bar increases expected model and verification cost.'));
  } else if (structuredTask.qualityBar === 'balanced') {
    factors.push(makeFactor('budget-pressure', 'quality-cost', 1, 'Balanced quality bar keeps moderate cost pressure.'));
  } else {
    factors.push(makeFactor('budget-pressure', 'quality-cost', 0, 'Fast quality bar lowers cost pressure.'));
  }

  if (structuredTask.contextSummary.length >= 4) {
    factors.push(makeFactor('budget-pressure', 'context-volume', 3, 'Many context refs increase prompt budget pressure.'));
  } else if (structuredTask.contextSummary.length >= 2) {
    factors.push(makeFactor('budget-pressure', 'context-volume', 1, 'Multiple context refs add moderate prompt cost.'));
  }

  if (contextSummaryText.includes('truncated') || contextSummaryText.includes('tokens≈')) {
    factors.push(makeFactor('budget-pressure', 'context-pruning', 2, 'Pruned or truncated context signals token pressure.'));
  }

  if (structuredTask.target.kind === 'workspace') {
    factors.push(makeFactor('budget-pressure', 'workspace-cost', 2, 'Workspace routing can consume broader context budget.'));
  }

  if (structuredTask.taskType === 'analysis' || structuredTask.taskType === 'implementation') {
    factors.push(makeFactor('budget-pressure', 'task-cost', 1, `${structuredTask.taskType} task often needs longer output and reasoning.`));
  }

  return factors;
}

function sumFactors(factors: RouteScoreFactor[], dimension: RouteScoreDimension): number {
  return clampScore(factors.filter((factor) => factor.dimension === dimension).reduce((sum, factor) => sum + factor.score, 0));
}

function buildCompositeScore(complexityScore: number, riskScore: number, budgetPressureScore: number, config: RouteScoringConfig): number {
  return Number((
    complexityScore * config.complexityWeight
    + riskScore * config.riskWeight
    + budgetPressureScore * config.budgetPressureWeight
  ).toFixed(2));
}

function buildConfidence(route: RouteTier, compositeScore: number, config: RouteScoringConfig): number {
  const distanceFromThreshold = Math.abs(compositeScore - config.complexThreshold);
  const base = route === 'simple' ? 0.6 : 0.58;
  const confidence = base + Math.min(distanceFromThreshold, 6) * 0.06;
  return clampConfidence(distanceFromThreshold < config.lowConfidenceMargin ? Math.min(confidence, 0.69) : confidence);
}

function buildRouteReason(route: RouteTier, factors: RouteScoreFactor[], compositeScore: number, config: RouteScoringConfig): string {
  const topFactors = [...factors].sort((left, right) => right.score - left.score).slice(0, 3);

  if (route === 'simple') {
    const simpleSignals = unique(
      topFactors
        .filter((factor) => factor.score === 0)
        .map((factor) => factor.detail),
    );

    return simpleSignals[0] ?? `Composite score ${compositeScore} stays below threshold ${config.complexThreshold}; use cheaper path.`;
  }

  return `${unique(topFactors.map((factor) => factor.detail)).join(' ')} Composite score ${compositeScore} meets threshold ${config.complexThreshold}.`;
}

function inferRouteDecision(result: StructurizerResult, scoringConfig?: Partial<RouteScoringConfig>, budgetPreference?: BudgetPreference): unknown {
  const baseConfig = resolveRouteScoringConfig(scoringConfig);
  const config = resolveBudgetAwareScoringConfig(baseConfig, budgetPreference);
  const scoreBreakdown = [
    ...buildComplexityFactors(result),
    ...buildRiskFactors(result),
    ...buildBudgetPressureFactors(result),
  ];
  const complexityScore = sumFactors(scoreBreakdown, 'complexity');
  const riskScore = sumFactors(scoreBreakdown, 'risk');
  const budgetPressureScore = sumFactors(scoreBreakdown, 'budget-pressure');
  const compositeScore = buildCompositeScore(complexityScore, riskScore, budgetPressureScore, config);
  const route: RouteTier = compositeScore >= config.complexThreshold ? 'complex' : 'simple';
  const confidence = buildConfidence(route, compositeScore, config);
  const budgetConflict = detectBudgetConflict(result, budgetPreference);

  return {
    status: 'routed',
    route,
    reason: buildRouteReason(route, scoreBreakdown, compositeScore, config),
    confidence,
    complexityScore,
    riskScore,
    budgetPressureScore,
    compositeScore,
    scoreBreakdown,
    scoringConfig: config,
    strategy: 'rules-v2',
    budgetConflict,
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
  const config = DEFAULT_ROUTE_SCORING_CONFIG;
  return RouteDecisionSchema.parse({
    status: 'fallback',
    route: 'complex',
    reason: 'Router fell back to safer complex path.',
    confidence: 0.2,
    complexityScore: 12,
    riskScore: 12,
    budgetPressureScore: 8,
    compositeScore: buildCompositeScore(12, 12, 8, config),
    scoreBreakdown: [
      {
        factor: 'router-fallback',
        dimension: 'risk',
        score: 4,
        detail: reason,
      },
    ],
    scoringConfig: config,
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

export function routeTask(result: StructurizerResult, scoringConfig?: Partial<RouteScoringConfig>, budgetPreference?: BudgetPreference): RouteDecision {
  return parseRouteDecision(inferRouteDecision(result, scoringConfig, budgetPreference));
}

type RouterAssistantProviderInvoker = {
  invoke(request: ProviderInvocationRequest): Promise<{
    providerId: string;
    modelId: string;
    outputText: string;
    latencyMs: number;
  }>;
};

function buildRouterAssistantUserPrompt(result: StructurizerResult): string {
  const task = result.structuredTask;
  return [
    'Review this structured task and return a JSON routing advisory.',
    `taskType=${task.taskType}`,
    `target=${task.target.kind}`,
    `qualityBar=${task.qualityBar}`,
    `constraints=${task.constraints.length}`,
    `openQuestions=${task.openQuestions.length}`,
    `uncertaintyReasons=${task.uncertaintyReasons.length}`,
    `contextSummaryCount=${task.contextSummary.length}`,
    task.constraints.length > 0 ? `First constraint: ${task.constraints[0]}` : undefined,
    task.openQuestions.length > 0 ? `First open question: ${task.openQuestions[0]}` : undefined,
    task.uncertaintyReasons.length > 0 ? `First uncertainty: ${task.uncertaintyReasons[0]}` : undefined,
    'Return JSON only. No markdown.',
  ].filter(Boolean).join('\n');
}

function extractJsonCandidate(text: string): string {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) {
    return trimmed;
  }

  const braceCount: number[] = [];
  for (let i = jsonStart; i < trimmed.length; i += 1) {
    if (trimmed[i] === '{') {
      braceCount.push(1);
    } else if (trimmed[i] === '}') {
      braceCount.pop();
    }
    if (braceCount.length === 0) {
      return trimmed.slice(jsonStart, i + 1);
    }
  }

  while (braceCount.length > 0 && trimmed.endsWith('}')) {
    braceCount.pop();
    const lastBrace = trimmed.lastIndexOf('}');
    return trimmed.slice(jsonStart, lastBrace + 1);
  }

  return trimmed.slice(jsonStart);
}

function parseRouterAssistantOutput(rawOutput: string, modelId: string, latencyMs: number): RouteAssistantResult {
  try {
    const candidate = extractJsonCandidate(rawOutput);
    const parsed = JSON.parse(candidate);

    return RouteAssistantResultSchema.parse({
      status: 'available',
      modelId,
      suggestedRoute: parsed.suggestedRoute,
      complexityLabel: parsed.complexityLabel,
      riskLabel: parsed.riskLabel,
      budgetLabel: parsed.budgetLabel,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
      latencyMs,
    });
  } catch {
    return RouteAssistantResultSchema.parse({
      status: 'unavailable',
      modelId,
      latencyMs,
      error: 'Router assistant response could not be parsed.',
    });
  }
}

function labelToScoreAdjustment(label: string | undefined): number {
  switch (label) {
    case 'low':
      return -2;
    case 'moderate':
      return 0;
    case 'high':
      return 2;
    default:
      return 0;
  }
}

function mergeAssistantScores(
  rulesDecision: RouteDecision,
  assistantResult: RouteAssistantResult,
): RouteDecision {
  if (assistantResult.status !== 'available') {
    return RouteDecisionSchema.parse({
      ...rulesDecision,
      assistantResult,
    });
  }

  const weight = ROUTER_ASSISTANT_HYBRID_WEIGHT;
  const adjustedComplexity = clampScore(
    rulesDecision.complexityScore + labelToScoreAdjustment(assistantResult.complexityLabel) * weight,
  );
  const adjustedRisk = clampScore(
    (rulesDecision.riskScore ?? 0) + labelToScoreAdjustment(assistantResult.riskLabel) * weight,
  );
  const adjustedBudget = clampScore(
    (rulesDecision.budgetPressureScore ?? 0) + labelToScoreAdjustment(assistantResult.budgetLabel) * weight,
  );
  const config = rulesDecision.scoringConfig ?? DEFAULT_ROUTE_SCORING_CONFIG;
  const compositeScore = buildCompositeScore(adjustedComplexity, adjustedRisk, adjustedBudget, config);
  const suggestedRoute: RouteTier = assistantResult.suggestedRoute ?? (compositeScore >= config.complexThreshold ? 'complex' : 'simple');
  const confidence = Math.max(
    rulesDecision.confidence,
    (assistantResult.confidence ?? 0.5) * 0.7 + rulesDecision.confidence * 0.3,
  );

  return RouteDecisionSchema.parse({
    ...rulesDecision,
    route: suggestedRoute,
    reason: `${rulesDecision.reason} Model advisor: ${assistantResult.reasoning ?? 'no reasoning provided.'}`,
    confidence,
    complexityScore: adjustedComplexity,
    riskScore: adjustedRisk,
    budgetPressureScore: adjustedBudget,
    compositeScore,
    strategy: 'rules-v2-hybrid',
    assistantResult,
  });
}

async function invokeRouterAssistant(
  providerInvoker: RouterAssistantProviderInvoker,
  modelId: string,
  result: StructurizerResult,
): Promise<RouteAssistantResult> {
  const started = Date.now();

  try {
    const response = await providerInvoker.invoke({
      modelId,
      prompt: buildRouterAssistantUserPrompt(result),
      systemPrompt: ROUTER_ASSISTANT_SYSTEM_PROMPT,
      temperature: 0,
      maxOutputTokens: ROUTER_ASSISTANT_MAX_OUTPUT_TOKENS,
      timeoutMs: ROUTER_ASSISTANT_TIMEOUT_MS,
      metadata: {
        assistant: 'router',
        taskType: result.structuredTask.taskType,
      },
    });

    return parseRouterAssistantOutput(response.outputText, modelId, Date.now() - started);
  } catch (error) {
    const reason = error instanceof ProviderInvocationError
      ? `Router assistant provider error: ${error.message}`
      : error instanceof Error
        ? `Router assistant failed: ${error.message}`
        : 'Router assistant failed with unknown error.';

    return RouteAssistantResultSchema.parse({
      status: 'unavailable',
      modelId,
      latencyMs: Date.now() - started,
      error: reason,
    });
  }
}

export async function routeTaskWithAssistant(
  providerInvoker: RouterAssistantProviderInvoker | undefined,
  modelId: string | undefined,
  result: StructurizerResult,
  scoringConfig?: Partial<RouteScoringConfig>,
  budgetPreference?: BudgetPreference,
): Promise<RouteDecision> {
  const rulesDecision = routeTask(result, scoringConfig, budgetPreference);

  if (!providerInvoker || !modelId) {
    return rulesDecision;
  }

  const assistantResult = await invokeRouterAssistant(providerInvoker, modelId, result);

  return mergeAssistantScores(rulesDecision, assistantResult);
}