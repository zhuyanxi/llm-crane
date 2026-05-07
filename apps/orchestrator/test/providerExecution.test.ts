import { describe, expect, it, vi } from 'vitest';
import { ProviderInvocationError } from '@llm-crane/providers';
import type { PlannerResult, ReasonerResult, RouteDecision, StructurizerResult, TaskRequest } from '@llm-crane/schemas';
import { buildProviderUserPrompt, invokeRoutedProvider } from '../src/providerExecution';

const baseTaskRequest: TaskRequest = {
  task: 'Analyze current file for bug risk.',
  qualityBar: 'balanced',
  constraints: ['Keep public API stable'],
  contexts: [
    {
      source: 'file',
      uri: '/workspace/src/app.ts',
      languageId: 'typescript',
      content: 'export const value = 1;',
    },
  ],
};

const baseStructurizerResult: StructurizerResult = {
  status: 'structured',
  structuredTask: {
    originalTask: baseTaskRequest.task,
    taskType: 'analysis',
    goal: baseTaskRequest.task,
    target: {
      kind: 'file',
      value: '/workspace/src/app.ts',
      uri: '/workspace/src/app.ts',
    },
    qualityBar: 'balanced',
    constraints: ['Keep public API stable'],
    openQuestions: [],
    uncertaintyReasons: [],
    contextSummary: ['file / typescript / /workspace/src/app.ts'],
  },
  warnings: [],
};

const baseRouteDecision: RouteDecision = {
  status: 'routed',
  route: 'complex',
  reason: 'Analysis task needs broader reasoning.',
  confidence: 0.81,
  complexityScore: 6,
  scoreBreakdown: [
    {
      factor: 'task-type',
      score: 2,
      detail: 'Analysis task needs broader reasoning.',
    },
  ],
  strategy: 'rules-v1',
};

const basePlannerResult: PlannerResult = {
  status: 'planned',
  summary: 'Execution plan for analysis task with 3 ordered steps.',
  steps: [
    {
      stepId: 'inspect-context',
      title: 'Inspect context and target',
      objective: 'Review attached contexts and constraints.',
      acceptance: 'Prompt reflects context and constraints.',
    },
    {
      stepId: 'survey-target',
      title: 'Survey target and risks',
      objective: 'Inspect target and identify main risks.',
      acceptance: 'Prompt names key files and risk areas.',
    },
    {
      stepId: 'deliver-answer',
      title: 'Deliver bounded final answer',
      objective: 'Return bounded answer with validation notes.',
      acceptance: 'Prompt requests explicit risks and next validation.',
    },
  ],
  decisionPoints: [
    {
      question: 'Proceed conservatively?',
      whyItMatters: 'Missing detail may widen scope.',
      options: ['Yes', 'No'],
      defaultChoice: 'Yes',
    },
  ],
  openQuestions: [],
  downstreamHints: {
    reasonerFocus: ['Keep main risk explicit.'],
    verifierChecks: ['Check public API stability.'],
  },
  warnings: [],
};

const baseReasonerResult: ReasonerResult = {
  status: 'reasoned',
  needReasoning: true,
  decisionSource: 'router+planner',
  escalationReason: 'Workspace-wide scope requires cross-file synthesis before execution.',
  summary: 'Escalate reasoning for analysis on /workspace/src/app.ts.',
  keyEvidence: ['Task type: analysis', 'Target: /workspace/src/app.ts'],
  warnings: [],
};

describe('buildProviderUserPrompt', () => {
  it('includes task, structure, route, planner result, reasoner result, and contexts', () => {
    const prompt = buildProviderUserPrompt(
      baseTaskRequest,
      baseStructurizerResult,
      baseRouteDecision,
      basePlannerResult,
      baseReasonerResult,
    );

    expect(prompt).toContain('Original task:');
    expect(prompt).toContain('Structured task:');
    expect(prompt).toContain('Route decision:');
    expect(prompt).toContain('Planner result:');
    expect(prompt).toContain('Reasoner result:');
    expect(prompt).toContain('Execution plan for analysis task');
    expect(prompt).toContain('Escalate reasoning for analysis');
    expect(prompt).toContain('/workspace/src/app.ts');
  });
});

describe('invokeRoutedProvider', () => {
  it('maps provider success into completed execution result', async () => {
    const invoke = vi.fn().mockResolvedValue({
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet-latest',
      outputText: 'analysis result',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 100,
        outputTokens: 40,
      },
      latencyMs: 500,
    });

    const result = await invokeRoutedProvider(
      { invoke },
      'claude-3-5-sonnet-latest',
      baseTaskRequest,
      baseStructurizerResult,
      baseRouteDecision,
      basePlannerResult,
      baseReasonerResult,
    );

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('analysis result');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          plannerStatus: 'planned',
          reasonerStatus: 'reasoned',
          needReasoning: 'true',
        }),
      }),
    );
  });

  it('maps provider errors into unified failed execution result', async () => {
    const invoke = vi.fn().mockRejectedValue(
      new ProviderInvocationError('Rate limit exceeded', {
        providerId: 'openai',
        code: 'rate_limit',
        retriable: true,
        statusCode: 429,
      }),
    );

    const result = await invokeRoutedProvider(
      { invoke },
      'gpt-4o-mini',
      { ...baseTaskRequest, qualityBar: 'fast' },
      { ...baseStructurizerResult, structuredTask: { ...baseStructurizerResult.structuredTask, qualityBar: 'fast' } },
      { ...baseRouteDecision, route: 'simple' },
      undefined,
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('rate_limit');
    expect(result.error?.retriable).toBe(true);
  });
});