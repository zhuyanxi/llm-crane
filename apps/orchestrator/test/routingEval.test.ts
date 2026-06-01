import { describe, expect, it } from 'vitest';
import {
  ROUTING_EVAL_SAMPLES,
  sampleToTaskRequest,
  type RoutingEvalReport,
  type RoutingEvalResult,
} from '../evals/routingEvalSamples';
import { routeTask, routeTaskWithAssistant } from '../src/router';
import { structurizeTaskRequest } from '../src/structurizer';

function runRulesEval(): RoutingEvalReport {
  const results: RoutingEvalResult[] = [];

  for (const sample of ROUTING_EVAL_SAMPLES) {
    const result = structurizeTaskRequest(sampleToTaskRequest(sample));
    const decision = routeTask(result);

    const routeMatch = decision.route === sample.expectedRoute;
    const scoreInRange = sample.complexityScoreMin !== undefined && sample.complexityScoreMax !== undefined
      ? decision.complexityScore >= sample.complexityScoreMin && decision.complexityScore <= sample.complexityScoreMax
      : true;
    const passed = routeMatch || (sample.tolerance === 'loose' && scoreInRange);

    results.push({
      sampleId: sample.id,
      expectedRoute: sample.expectedRoute,
      actualRoute: decision.route,
      passed,
      strategy: decision.strategy,
      complexityScore: decision.complexityScore,
      riskScore: decision.riskScore ?? 0,
      budgetPressureScore: decision.budgetPressureScore ?? 0,
      compositeScore: decision.compositeScore ?? decision.complexityScore,
      confidence: decision.confidence,
      costLabel: sample.costLabel,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  const simpleCount = results.filter((r) => r.actualRoute === 'simple').length;
  const complexCount = results.filter((r) => r.actualRoute === 'complex').length;
  const tolerantPassed = results.filter((r) => r.passed).length;

  return {
    results,
    summary: {
      total: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
      tolerantPassed,
      simpleRoutes: simpleCount,
      complexRoutes: complexCount,
      costSavingsEstimate: `${simpleCount}/${results.length} tasks routed simple (cheaper path).`,
    },
  };
}

describe('routing eval', () => {
  it('passes expected routes for rules-v2 scoring', () => {
    const report = runRulesEval();

    for (const result of report.results) {
      if (result.passed) {
        continue;
      }

      // Log failure detail for debugging
      console.warn(
        `FAIL ${result.sampleId}: expected=${result.expectedRoute} actual=${result.actualRoute} ` +
        `complexity=${result.complexityScore} risk=${result.riskScore} budget=${result.budgetPressureScore} ` +
        `composite=${result.compositeScore} confidence=${result.confidence}`,
      );
    }

    expect(report.summary.passed).toBeGreaterThanOrEqual(report.summary.total - 1);
    expect(report.summary.simpleRoutes).toBeGreaterThanOrEqual(3);
    expect(report.summary.complexRoutes).toBeGreaterThanOrEqual(3);
  });

  it('reports cost dimension: most low-cost tasks route simple', () => {
    const report = runRulesEval();
    const lowCostResults = report.results.filter((r) => r.costLabel === 'low');
    const lowCostSimple = lowCostResults.filter((r) => r.actualRoute === 'simple');

    expect(lowCostResults.length).toBeGreaterThanOrEqual(3);
    expect(lowCostSimple.length).toBeGreaterThanOrEqual(lowCostResults.length - 1);
  });

  it('reports quality dimension: high-cost tasks route complex', () => {
    const report = runRulesEval();
    const highCostResults = report.results.filter((r) => r.costLabel === 'high');

    expect(highCostResults.length).toBeGreaterThanOrEqual(2);
    for (const result of highCostResults) {
      expect(result.actualRoute).toBe('complex');
    }
  });

  it('generates printable report for documentation', () => {
    const report = runRulesEval();
    const lines = [
      `Routing Eval Report — ${report.summary.total} samples`,
      `Pass: ${report.summary.passed}/${report.summary.total}`,
      `Simple: ${report.summary.simpleRoutes} Complex: ${report.summary.complexRoutes}`,
      report.summary.costSavingsEstimate,
      '',
      ...report.results.map((r) =>
        `${r.passed ? '✓' : '✗'} ${r.sampleId} | ${r.expectedRoute}→${r.actualRoute} | ` +
        `c=${r.complexityScore} r=${r.riskScore} b=${r.budgetPressureScore} ` +
        `composite=${r.compositeScore} | cost=${r.costLabel} strategy=${r.strategy}`,
      ),
    ];

    const reportText = lines.join('\n');
    expect(reportText).toContain('Routing Eval Report');
    expect(reportText).toContain('Pass:');
    expect(reportText).toContain('cost=');
  });

  it('compares rules-v2 with hybrid assistant when hybrid results differ', async () => {
    const sample = ROUTING_EVAL_SAMPLES.find((s) => s.id === 'debug-workspace-open-questions');
    if (!sample) {
      throw new Error('Sample not found');
    }

    const result = structurizeTaskRequest(sampleToTaskRequest(sample));
    const rulesDecision = routeTask(result);

    // Hybrid with mock invoker that suggests simple route
    const mockInvoker = {
      async invoke() {
        return {
          providerId: 'openai',
          modelId: 'cheap-model',
          outputText: JSON.stringify({
            suggestedRoute: 'simple',
            complexityLabel: 'moderate',
            riskLabel: 'moderate',
            budgetLabel: 'high',
            reasoning: 'CI timeout likely a single configuration issue, not multi-file refactor.',
            confidence: 0.65,
          }),
          latencyMs: 30,
        };
      },
    };

    const hybridDecision = await routeTaskWithAssistant(mockInvoker, 'cheap-model', result);

    expect(rulesDecision.strategy).toBe('rules-v2');
    expect(hybridDecision.strategy).toBe('rules-v2-hybrid');
    expect(hybridDecision.assistantResult?.status).toBe('available');
    // Hybrid may differ from rules — record both for report
    expect(hybridDecision.compositeScore).toBeDefined();
    expect(rulesDecision.compositeScore).toBeDefined();
  });
});
