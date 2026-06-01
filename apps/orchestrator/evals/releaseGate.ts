import { STAGE_EVAL_SAMPLES, sampleToTaskRequest } from './stageEvalSamples';
import { ROUTING_EVAL_SAMPLES } from './routingEvalSamples';
import { structurizeTaskRequest } from '../src/structurizer';
import { routeTask } from '../src/router';
import { planTask } from '../src/planner';
import { createSafeFallbackRouteDecision } from '../src/router';
import { runRuleVerifiers, createListFormatRuleVerifier, mergeVerificationResults, type VerifierContext } from '../src/verifier';
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
