import { describe, expect, it } from 'vitest';
import {
  STAGE_EVAL_SAMPLES,
  sampleToTaskRequest,
  type StageEvalSample,
} from '../evals/stageEvalSamples';
import { structurizeTaskRequest } from '../src/structurizer';
import { routeTask } from '../src/router';
import { planTask } from '../src/planner';
import { createSafeFallbackRouteDecision } from '../src/router';
import { runRuleVerifiers, createDeferredVerificationResult, mergeVerificationResults, createListFormatRuleVerifier, type VerifierContext } from '../src/verifier';
import type { ProviderExecutionResult, RouteDecision, StructurizerResult, TaskRequest } from '@llm-crane/schemas';

function filterByStage(stageId: string): StageEvalSample[] {
  return STAGE_EVAL_SAMPLES.filter((s) => s.stageId === stageId);
}

function buildStageReport(
  samples: StageEvalSample[],
  results: Array<{ sampleId: string; passed: boolean; detail: string }>,
  label: string,
): string {
  const passedCount = results.filter((r) => r.passed).length;
  const lines = [
    `=== ${label} Eval Report ===`,
    `${passedCount}/${results.length} passed`,
    ...results.map((r) => `${r.passed ? '✓' : '✗'} ${r.sampleId}: ${r.detail}`),
  ];
  return lines.join('\n');
}

describe('structurizer stage evals', () => {
  const samples = filterByStage('structurizer');

  for (const sample of samples) {
    it(`${sample.id}: ${sample.note}`, () => {
      const result = structurizeTaskRequest(sampleToTaskRequest(sample));

      if (sample.expectedStatus) {
        expect(result.status).toBe(sample.expectedStatus);
      }
      if (sample.expectedTaskType && result.status === 'structured') {
        expect(result.structuredTask.taskType).toBe(sample.expectedTaskType);
      }
      if (sample.expectedTargetKind && result.status === 'structured') {
        expect(result.structuredTask.target.kind).toBe(sample.expectedTargetKind);
      }
    });
  }
});

describe('router stage evals', () => {
  const samples = filterByStage('router');

  for (const sample of samples) {
    it(`${sample.id}: ${sample.note}`, () => {
      const structurizerResult = structurizeTaskRequest(sampleToTaskRequest(sample));
      const decision = routeTask(structurizerResult);

      if (sample.expectedRoute) {
        const routeMatch = decision.route === sample.expectedRoute;
        const scoreOk = sample.minComplexityScore !== undefined
          ? decision.complexityScore >= sample.minComplexityScore
          : true;
        const passed = routeMatch || (sample.routerTolerance === 'loose' && scoreOk);
        expect(passed).toBe(true);
      }
      if (sample.minComplexityScore !== undefined) {
        expect(decision.complexityScore).toBeGreaterThanOrEqual(sample.minComplexityScore);
      }
    });
  }
});

describe('planner stage evals', () => {
  const samples = filterByStage('planner');

  for (const sample of samples) {
    it(`${sample.id}: ${sample.note}`, () => {
      const taskRequest = sampleToTaskRequest(sample);
      const structurizerResult = structurizeTaskRequest(taskRequest);

      let routeDecision: RouteDecision;
      if (structurizerResult.status === 'structured') {
        routeDecision = routeTask(structurizerResult);
        if (routeDecision.route !== 'complex') {
          // Planner only runs on complex route
          return;
        }
      } else {
        routeDecision = createSafeFallbackRouteDecision('structurizer fallback forces planner test path');
      }

      const plannerResult = planTask(taskRequest, structurizerResult, routeDecision);

      if (sample.expectedPlannerStatus) {
        expect(plannerResult.status).toBe(sample.expectedPlannerStatus);
      }
      if (sample.minPlanSteps !== undefined) {
        expect(plannerResult.steps.length).toBeGreaterThanOrEqual(sample.minPlanSteps);
      }
    });
  }
});

describe('verifier stage evals', () => {
  const samples = filterByStage('verifier');

  for (const sample of samples) {
    it(`${sample.id}: ${sample.note}`, async () => {
      const taskRequest = sampleToTaskRequest(sample);
      const structurizerResult = structurizeTaskRequest(taskRequest);
      const routeDecision = structurizerResult.status === 'structured'
        ? routeTask(structurizerResult)
        : createSafeFallbackRouteDecision('structurizer fallback for verifier eval');

      const providerResult: ProviderExecutionResult = {
        status: sample.verifierProviderStatus === 'failed' ? 'failed' : 'completed',
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        outputText: sample.verifierOutputText ?? '',
        latencyMs: 100,
        error: sample.verifierProviderStatus === 'failed'
          ? { providerId: 'openai', code: 'rate_limit', message: 'Rate limited.', retriable: true }
          : undefined,
      };

      const context: VerifierContext = {
        taskRequest,
        structurizerResult,
        routeDecision,
        providerResult,
        output: providerResult.outputText,
      };

      // Run rule verifier with list-format checker
      const results = await runRuleVerifiers(context, [
        createListFormatRuleVerifier(),
      ]);
      const merged = mergeVerificationResults(results);

      if (sample.expectedVerdict) {
        expect(merged.verdict).toBe(sample.expectedVerdict);
      }
      if (sample.expectedAction) {
        expect(merged.suggestedAction).toBe(sample.expectedAction);
      }
      if (sample.expectedFindingCode) {
        const hasCode = merged.findings.some((f) => f.code === sample.expectedFindingCode);
        expect(hasCode).toBe(true);
      }
    });
  }
});

describe('stage eval report', () => {
  it('generates per-stage printable summary', () => {
    const stages = ['structurizer', 'router', 'planner', 'verifier'];
    const lines: string[] = ['Stage Eval Report Summary', ''];

    for (const stageId of stages) {
      const stageSamples = filterByStage(stageId);
      lines.push(`${stageId}: ${stageSamples.length} samples`);
      for (const sample of stageSamples) {
        lines.push(`  - ${sample.id}: ${sample.note}`);
      }
    }

    const report = lines.join('\n');
    expect(report).toContain('structurizer:');
    expect(report).toContain('router:');
    expect(report).toContain('planner:');
    expect(report).toContain('verifier:');
    expect(report).toContain('Stage Eval Report Summary');
  });
});
