import { describe, expect, it } from 'vitest';
import type { StructurizerResult, TaskRequest } from '@llm-crane/schemas';
import { buildRouterScoreInput, parseRouteDecision, routeTask, routeTaskWithAssistant } from '../src/router';
import { structurizeTaskRequest } from '../src/structurizer';

function makeTaskRequest(task: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    task,
    qualityBar: 'balanced',
    contexts: [],
    constraints: [],
    ...overrides,
  };
}

describe('routeTask', () => {
  it('routes narrow refactor task to simple path', () => {
    const decision = routeTask(
      structurizeTaskRequest(
        makeTaskRequest('Refactor current selection to reduce duplication without changing public API.', {
          qualityBar: 'fast',
          contexts: [
            {
              source: 'selection',
              uri: '/workspace/src/auth.ts',
              languageId: 'typescript',
              content: 'function loginUser() { return doLogin(); }',
            },
          ],
        }),
      ),
    );

    expect(decision.status).toBe('routed');
    expect(decision.route).toBe('simple');
    expect(decision.reason).toContain('scope');
  });

  it('routes broad high-quality analysis task to complex path', () => {
    const decision = routeTask(
      structurizeTaskRequest(
        makeTaskRequest('Analyze whole workspace for architecture risk and propose robust fixes.', {
          qualityBar: 'high',
          contexts: [
            {
              source: 'workspace',
              uri: '/workspace',
              content: 'workspace snapshot',
            },
            {
              source: 'file',
              uri: '/workspace/src/server.ts',
              languageId: 'typescript',
              content: 'export function start() {}',
            },
          ],
          constraints: ['Keep public API stable', 'Avoid schema churn'],
        }),
      ),
    );

    expect(decision.status).toBe('routed');
    expect(decision.route).toBe('complex');
    expect(decision.complexityScore).toBeGreaterThanOrEqual(4);
    expect(decision.riskScore).toBeGreaterThan(0);
    expect(decision.budgetPressureScore).toBeGreaterThan(0);
    expect(decision.compositeScore).toBeGreaterThanOrEqual(4);
    expect(decision.strategy).toBe('rules-v2');
    expect(decision.scoreBreakdown.map((factor) => factor.dimension)).toEqual(expect.arrayContaining(['complexity', 'risk', 'budget-pressure']));
  });

  it('uses adjustable score weights when combining dimensions', () => {
    const structurizerResult: StructurizerResult = {
      status: 'structured',
      structuredTask: {
        taskType: 'refactor',
        qualityBar: 'fast',
        target: {
          kind: 'selection',
          value: 'selected function',
        },
        constraints: [],
        expectedOutput: [],
        openQuestions: ['Which compatibility edge cases matter?'],
        uncertaintyReasons: [],
        contextSummary: [],
      },
      warnings: [],
    };

    const defaultDecision = routeTask(structurizerResult);
    const riskWeightedDecision = routeTask(structurizerResult, {
      complexityWeight: 0,
      riskWeight: 1,
      budgetPressureWeight: 0,
      complexThreshold: 3,
    });

    expect(defaultDecision.route).toBe('simple');
    expect(riskWeightedDecision.route).toBe('complex');
    expect(riskWeightedDecision.scoringConfig?.riskWeight).toBe(1);
    expect(riskWeightedDecision.compositeScore).toBe(riskWeightedDecision.riskScore);
  });

  it('defaults to safe fallback path when route payload is invalid', () => {
    const decision = parseRouteDecision({ route: 'simple' });

    expect(decision.status).toBe('fallback');
    expect(decision.route).toBe('complex');
    expect(decision.fallbackReason).toContain('Router output invalid');
    expect(decision.riskScore).toBeGreaterThan(0);
  });
});

describe('buildRouterScoreInput', () => {
  it('summarizes structured-task fields for future scorer hook', () => {
    const result = structurizeTaskRequest(
      makeTaskRequest('Debug failing login flow in src/auth.ts. Error says token expires immediately.', {
        contexts: [
          {
            source: 'file',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'export async function login() { throw new Error(); }',
          },
        ],
      }),
    );

    const summary = buildRouterScoreInput(result);

    expect(summary).toContain('taskType=debug');
    expect(summary).toContain('target=file');
  });
});

describe('routeTaskWithAssistant', () => {
  function makeStructurizerResult(overrides: Partial<StructurizerResult['structuredTask']> = {}): StructurizerResult {
    return {
      status: 'structured',
      structuredTask: {
        taskType: 'debug',
        qualityBar: 'balanced',
        target: { kind: 'file', value: '/workspace/src/auth.ts' },
        constraints: ['Keep public API stable'],
        expectedOutput: [],
        openQuestions: ['Which auth provider?'],
        uncertaintyReasons: [],
        contextSummary: ['file / primary / typescript / /workspace/src/auth.ts'],
        ...overrides,
      },
      warnings: [],
    };
  }

  it('returns rules-only decision when provider invoker is undefined', async () => {
    const decision = await routeTaskWithAssistant(undefined, 'cheap-model', makeStructurizerResult());

    expect(decision.strategy).toBe('rules-v2');
    expect(decision.assistantResult).toBeUndefined();
    expect(decision.route).toBeDefined();
  });

  it('merges model high-risk suggestion into rules decision', async () => {
    const mockInvoker = {
      async invoke() {
        return {
          providerId: 'openai',
          modelId: 'cheap-model',
          outputText: JSON.stringify({
            suggestedRoute: 'complex',
            complexityLabel: 'moderate',
            riskLabel: 'high',
            budgetLabel: 'moderate',
            reasoning: 'Open question about auth provider raises integration risk.',
            confidence: 0.72,
          }),
          latencyMs: 45,
        };
      },
    };

    const decision = await routeTaskWithAssistant(
      mockInvoker,
      'cheap-model',
      makeStructurizerResult(),
    );

    expect(decision.strategy).toBe('rules-v2-hybrid');
    expect(decision.assistantResult?.status).toBe('available');
    expect(decision.assistantResult?.reasoning).toContain('auth provider');
    expect(decision.reason).toContain('Model advisor');
    expect((decision.riskScore ?? 0)).toBeGreaterThan(0);
  });

  it('falls back to rules-only when model invocation fails', async () => {
    const mockInvoker = {
      async invoke() {
        throw new Error('Network timeout');
      },
    };

    const decision = await routeTaskWithAssistant(
      mockInvoker,
      'cheap-model',
      makeStructurizerResult(),
    );

    expect(decision.strategy).toBe('rules-v2');
    expect(decision.assistantResult?.status).toBe('unavailable');
    expect(decision.assistantResult?.error).toContain('Network timeout');
    expect(decision.route).toBeDefined();
  });

  it('uses model suggested-route when model is confident and rules disagree', async () => {
    const mockInvoker = {
      async invoke() {
        return {
          providerId: 'openai',
          modelId: 'cheap-model',
          outputText: JSON.stringify({
            suggestedRoute: 'complex',
            complexityLabel: 'high',
            riskLabel: 'high',
            budgetLabel: 'high',
            reasoning: 'Debug task with open questions needs stronger reasoning path.',
            confidence: 0.88,
          }),
          latencyMs: 32,
        };
      },
    };

    const result = makeStructurizerResult({
      taskType: 'debug',
      target: { kind: 'selection', value: 'const x = 1;' },
      qualityBar: 'fast',
      constraints: [],
      openQuestions: [],
      uncertaintyReasons: [],
      contextSummary: [],
      expectedOutput: [],
    });

    const decision = await routeTaskWithAssistant(mockInvoker, 'cheap-model', result);

    expect(decision.strategy).toBe('rules-v2-hybrid');
    expect(decision.assistantResult?.suggestedRoute).toBe('complex');
    expect(decision.confidence).toBeGreaterThanOrEqual(0.7);
  });
});