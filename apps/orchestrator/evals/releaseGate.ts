import { STAGE_EVAL_SAMPLES, sampleToTaskRequest } from './stageEvalSamples';
import { ROUTING_EVAL_SAMPLES } from './routingEvalSamples';
import { structurizeTaskRequest } from '../src/structurizer';
import { routeTask } from '../src/router';
import { planTask } from '../src/planner';
import { createSafeFallbackRouteDecision } from '../src/router';
import { runRuleVerifiers, createListFormatRuleVerifier, mergeVerificationResults, type VerifierContext } from '../src/verifier';
import { getPromptVersionDetail, type PromptStageId } from '@llm-crane/prompts';
import type { ProviderExecutionResult, RouteDecision } from '@llm-crane/schemas';

export type GateFailure = {
  sampleId: string;
  stage: string;
  expected: string;
  actual: string;
  detail: string;
};

export type GateStageSummary = {
  total: number;
  passed: number;
  failed: number;
};

export type ReleaseGateReport = {
  gatePassed: boolean;
  releaseReady: boolean;
  routing: GateStageSummary & { tolerantSkipped: number };
  stages: Record<string, GateStageSummary>;
  blockingFailures: GateFailure[];
  summary: string;
};

export type CostQualityDimension = {
  simpleRouteRatio: number;
  complexRouteRatio: number;
  estimatedSimpleLatencyMs: number;
  estimatedComplexLatencyMs: number;
  avgConfidence: number;
  avgComplexityScore: number;
  avgRiskScore: number;
  avgBudgetPressureScore: number;
  avgCompositeScore: number;
};

export type StrategyComparison = {
  strategyA: string;
  strategyB: string;
  a: CostQualityDimension;
  b: CostQualityDimension;
  routeDivergence: number;
  note: string;
};

export type CostQualityReport = {
  timestamp: string;
  promptVersions: Record<string, string>;
  rulesV2: CostQualityDimension;
  hybridComparison?: StrategyComparison;
  gatePassed: boolean;
  costSavingsEstimate: string;
  releaseRecommendation: string;
  summary: string;
};

function runRoutingGate(): { passed: number; failed: number; tolerantSkipped: number; failures: GateFailure[] } {
  let passed = 0;
  let failed = 0;
  let tolerantSkipped = 0;
  const failures: GateFailure[] = [];

  for (const sample of ROUTING_EVAL_SAMPLES) {
    const result = structurizeTaskRequest(sampleToTaskRequest(sample));
    const decision = routeTask(result);
    const routeMatch = decision.route === sample.expectedRoute;

    if (routeMatch) {
      passed++;
    } else if (sample.tolerance === 'loose') {
      tolerantSkipped++;
    } else {
      failed++;
      failures.push({
        sampleId: sample.id,
        stage: 'router',
        expected: sample.expectedRoute,
        actual: decision.route,
        detail: `expected=${sample.expectedRoute} actual=${decision.route} complexity=${decision.complexityScore}`,
      });
    }
  }

  return { passed, failed, tolerantSkipped, failures };
}

async function runStageGate(): Promise<{ passed: number; failed: number; failures: GateFailure[] }> {
  let passed = 0;
  let failed = 0;
  const failures: GateFailure[] = [];

  for (const sample of STAGE_EVAL_SAMPLES) {
    const taskRequest = sampleToTaskRequest(sample);

    try {
      if (sample.stageId === 'structurizer') {
        const result = structurizeTaskRequest(taskRequest);
        const statusMatch = !sample.expectedStatus || result.status === sample.expectedStatus;
        if (statusMatch) { passed++; } else {
          failed++;
          failures.push({ sampleId: sample.id, stage: 'structurizer', expected: sample.expectedStatus ?? '', actual: result.status, detail: sample.note });
        }
      } else if (sample.stageId === 'router') {
        const structurizerResult = structurizeTaskRequest(taskRequest);
        const decision = routeTask(structurizerResult);
        const routeMatch = !sample.expectedRoute || decision.route === sample.expectedRoute;
        const scoreOk = sample.minComplexityScore !== undefined
          ? decision.complexityScore >= sample.minComplexityScore
          : true;
        const ok = routeMatch || (sample.routerTolerance === 'loose' && scoreOk);
        if (ok) { passed++; } else {
          failed++;
          failures.push({ sampleId: sample.id, stage: 'router', expected: sample.expectedRoute ?? '', actual: decision.route, detail: sample.note });
        }
      } else if (sample.stageId === 'planner') {
        const structurizerResult = structurizeTaskRequest(taskRequest);
        let routeDecision: RouteDecision;
        if (structurizerResult.status === 'structured') {
          routeDecision = routeTask(structurizerResult);
          if (routeDecision.route !== 'complex') { passed++; continue; }
        } else {
          routeDecision = createSafeFallbackRouteDecision('structurizer fallback for gate');
        }
        const plannerResult = planTask(taskRequest, structurizerResult, routeDecision);
        const statusMatch = !sample.expectedPlannerStatus || plannerResult.status === sample.expectedPlannerStatus;
        if (statusMatch) { passed++; } else {
          failed++;
          failures.push({ sampleId: sample.id, stage: 'planner', expected: sample.expectedPlannerStatus ?? '', actual: plannerResult.status, detail: sample.note });
        }
      } else if (sample.stageId === 'verifier') {
        const structurizerResult = structurizeTaskRequest(taskRequest);
        const routeDecision = structurizerResult.status === 'structured'
          ? routeTask(structurizerResult)
          : createSafeFallbackRouteDecision('fallback');
        const providerResult: ProviderExecutionResult = {
          status: sample.verifierProviderStatus === 'failed' ? 'failed' : 'completed',
          providerId: 'openai', modelId: 'gpt-4o-mini',
          outputText: sample.verifierOutputText ?? '', latencyMs: 100,
          error: sample.verifierProviderStatus === 'failed'
            ? { providerId: 'openai', code: 'rate_limit', message: 'Rate limited.', retriable: true }
            : undefined,
        };
        const results = await runRuleVerifiers(
          { taskRequest, structurizerResult, routeDecision, providerResult, output: providerResult.outputText },
          [createListFormatRuleVerifier()],
        );
        const merged = mergeVerificationResults(results);
        const verdictMatch = !sample.expectedVerdict || merged.verdict === sample.expectedVerdict;
        if (verdictMatch) { passed++; } else {
          failed++;
          failures.push({ sampleId: sample.id, stage: 'verifier', expected: sample.expectedVerdict ?? '', actual: merged.verdict, detail: sample.note });
        }
      } else {
        passed++;
      }
    } catch (error) {
      failed++;
      failures.push({ sampleId: sample.id, stage: sample.stageId, expected: 'no-error', actual: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return { passed, failed, failures };
}

export async function runReleaseGate(): Promise<ReleaseGateReport> {
  const routing = runRoutingGate();
  const stageResults = await runStageGate();

  const allFailures = [...routing.failures, ...stageResults.failures];
  const routingTotal = routing.passed + routing.failed + routing.tolerantSkipped;
  const stageTotal = stageResults.passed + stageResults.failed;
  const gatePassed = routing.failed === 0 && stageResults.failed === 0;

  const stageBreakdown: Record<string, GateStageSummary> = {};
  for (const sample of STAGE_EVAL_SAMPLES) {
    if (!stageBreakdown[sample.stageId]) {
      stageBreakdown[sample.stageId] = { total: 0, passed: 0, failed: 0 };
    }
    const entry = stageBreakdown[sample.stageId];
    entry.total++;
    if (!allFailures.some((f) => f.sampleId === sample.id)) {
      entry.passed++;
    } else {
      entry.failed++;
    }
  }

  const summaryLines = [
    `Release Gate: ${gatePassed ? 'PASSED' : 'FAILED'}`,
    `Routing: ${routing.passed}/${routingTotal} passed${routing.tolerantSkipped > 0 ? ` (${routing.tolerantSkipped} tolerant)` : ''}`,
    `Stages: ${stageResults.passed}/${stageTotal} passed`,
  ];
  for (const [stage, summary] of Object.entries(stageBreakdown)) {
    summaryLines.push(`  ${stage}: ${summary.passed}/${summary.total}`);
  }
  if (allFailures.length > 0) {
    summaryLines.push(`Blocking failures (${allFailures.length}):`);
    for (const f of allFailures) {
      summaryLines.push(`  ${f.sampleId} [${f.stage}]: expected=${f.expected} actual=${f.actual}`);
    }
  }

  return {
    gatePassed,
    releaseReady: gatePassed,
    routing: { total: routingTotal, passed: routing.passed, failed: routing.failed, tolerantSkipped: routing.tolerantSkipped },
    stages: stageBreakdown,
    blockingFailures: allFailures,
    summary: summaryLines.join('\n'),
  };
}

function computeCostQualityDimension(decisions: Array<{ route: string; confidence: number; complexityScore: number; riskScore: number; budgetPressureScore: number; compositeScore: number }>): CostQualityDimension {
  const total = decisions.length;
  if (total === 0) {
    return { simpleRouteRatio: 0, complexRouteRatio: 0, estimatedSimpleLatencyMs: 0, estimatedComplexLatencyMs: 0, avgConfidence: 0, avgComplexityScore: 0, avgRiskScore: 0, avgBudgetPressureScore: 0, avgCompositeScore: 0 };
  }

  const simpleCount = decisions.filter((d) => d.route === 'simple').length;
  const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

  return {
    simpleRouteRatio: Math.round((simpleCount / total) * 100) / 100,
    complexRouteRatio: Math.round(((total - simpleCount) / total) * 100) / 100,
    estimatedSimpleLatencyMs: 1200,
    estimatedComplexLatencyMs: 2400,
    avgConfidence: Math.round(avg(decisions.map((d) => d.confidence)) * 100) / 100,
    avgComplexityScore: Math.round(avg(decisions.map((d) => d.complexityScore)) * 10) / 10,
    avgRiskScore: Math.round(avg(decisions.map((d) => d.riskScore)) * 10) / 10,
    avgBudgetPressureScore: Math.round(avg(decisions.map((d) => d.budgetPressureScore)) * 10) / 10,
    avgCompositeScore: Math.round(avg(decisions.map((d) => d.compositeScore)) * 10) / 10,
  };
}

export async function runCostQualityReport(): Promise<CostQualityReport> {
  const promptVersions: Record<string, string> = {};
  for (const stageId of ['structurizer', 'router', 'planner', 'verifier', 'executor'] as PromptStageId[]) {
    const detail = getPromptVersionDetail(stageId);
    promptVersions[stageId] = `${detail.version} (${detail.hash})`;
  }

  // Rules-v2 evaluation
  const rulesDecisions: Array<{ route: string; confidence: number; complexityScore: number; riskScore: number; budgetPressureScore: number; compositeScore: number }> = [];
  for (const sample of ROUTING_EVAL_SAMPLES) {
    const result = structurizeTaskRequest(sampleToTaskRequest(sample));
    const decision = routeTask(result);
    rulesDecisions.push({
      route: decision.route,
      confidence: decision.confidence,
      complexityScore: decision.complexityScore,
      riskScore: decision.riskScore ?? 0,
      budgetPressureScore: decision.budgetPressureScore ?? 0,
      compositeScore: decision.compositeScore ?? decision.complexityScore,
    });
  }
  const rulesV2 = computeCostQualityDimension(rulesDecisions);

  // Cost savings estimate
  const simpleCount = rulesDecisions.filter((d) => d.route === 'simple').length;
  const savedComplexPipelineCost = simpleCount; // each simple route saves planner + reasoner + verifier model calls
  const costSavingsEstimate = `${simpleCount}/${rulesDecisions.length} tasks routed simple → saved ~${savedComplexPipelineCost} complex pipeline runs. Estimated latency: simple≈${rulesV2.estimatedSimpleLatencyMs}ms vs complex≈${rulesV2.estimatedComplexLatencyMs}ms.`;

  // Gate status
  const gate = await runReleaseGate();

  // Release recommendation
  const releaseRecommendation = gate.gatePassed
    ? `Release recommended. Gate passed with ${rulesV2.simpleRouteRatio * 100}% simple routes (cost savings). Avg confidence ${rulesV2.avgConfidence}.`
    : `Release blocked. ${gate.blockingFailures.length} failure(s) to resolve.`;

  const summaryLines = [
    '=== Cost-Quality Report ===',
    `Timestamp: ${new Date().toISOString()}`,
    '',
    'Prompt Versions:',
    ...Object.entries(promptVersions).map(([stage, version]) => `  ${stage}: ${version}`),
    '',
    'Rules-V2 Strategy:',
    `  Simple route ratio: ${(rulesV2.simpleRouteRatio * 100).toFixed(0)}%`,
    `  Avg confidence: ${rulesV2.avgConfidence}`,
    `  Avg composite score: ${rulesV2.avgCompositeScore}`,
    `  Avg complexity/risk/budget: ${rulesV2.avgComplexityScore}/${rulesV2.avgRiskScore}/${rulesV2.avgBudgetPressureScore}`,
    '',
    `Cost savings: ${costSavingsEstimate}`,
    '',
    `Gate: ${gate.gatePassed ? 'PASSED' : 'FAILED'}`,
    releaseRecommendation,
  ];

  return {
    timestamp: new Date().toISOString(),
    promptVersions,
    rulesV2,
    gatePassed: gate.gatePassed,
    costSavingsEstimate,
    releaseRecommendation,
    summary: summaryLines.join('\n'),
  };
}
