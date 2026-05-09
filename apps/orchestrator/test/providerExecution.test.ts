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
      priority: 'primary',
      uri: '/workspace/src/app.ts',
      languageId: 'typescript',
      content: 'export const value = 1;',
      truncated: false,
    },
  ],
};

const baseStructurizerResult: StructurizerResult = {
  status: 'structured',
  confidence: 0.87,
  structuredTask: {
    originalTask: baseTaskRequest.task,
    taskType: 'analysis',
    goal: baseTaskRequest.task,
    target: {
      kind: 'file',
      value: '/workspace/src/app.ts',
      uri: '/workspace/src/app.ts',
    },
    template: {
      templateId: 'architecture-analysis',
      label: 'Architecture Analysis',
      taskType: 'analysis',
      defaultConstraints: [],
      values: {
        scope: 'current file',
        focus: 'bug risk',
      },
    },
    qualityBar: 'balanced',
    constraints: ['Keep public API stable'],
    expectedOutput: ['Rank top risks and propose bounded remediation path.'],
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
    expect(prompt).toContain('priority=primary');
    expect(prompt).toContain('Expected output:');
    expect(prompt).toContain('Rank top risks');
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
        systemPrompt: expect.stringContaining('rank risks before recommending change'),
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
      new ProviderInvocationError('Invalid request payload', {
        providerId: 'openai',
        code: 'invalid_request',
        retriable: false,
        statusCode: 400,
      }),
    );

    const onRetryAttempt = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await invokeRoutedProvider(
      { invoke },
      'gpt-4o-mini',
      { ...baseTaskRequest, qualityBar: 'fast' },
      { ...baseStructurizerResult, structuredTask: { ...baseStructurizerResult.structuredTask, qualityBar: 'fast' } },
      { ...baseRouteDecision, route: 'simple' },
      undefined,
      undefined,
      {
        retryPolicy: {
          maxRetries: 3,
          backoffStrategy: 'fixed',
          baseDelayMs: 10,
          maxDelayMs: 10,
        },
        onRetryAttempt,
        sleep,
      },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('invalid_request');
    expect(result.error?.retriable).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(onRetryAttempt).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries retriable timeout and rate limit failures with configured backoff', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderInvocationError('Rate limit exceeded', {
          providerId: 'openai',
          code: 'rate_limit',
          retriable: true,
          statusCode: 429,
        }),
      )
      .mockRejectedValueOnce(
        new ProviderInvocationError('Provider request timed out', {
          providerId: 'openai',
          code: 'timeout',
          retriable: true,
          statusCode: 504,
        }),
      )
      .mockResolvedValue({
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        outputText: 'retry success',
        stopReason: 'stop',
        usage: {
          inputTokens: 90,
          outputTokens: 40,
          totalTokens: 130,
        },
        latencyMs: 320,
      });

    const onRetryAttempt = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await invokeRoutedProvider(
      { invoke },
      'gpt-4o-mini',
      { ...baseTaskRequest, qualityBar: 'fast' },
      { ...baseStructurizerResult, structuredTask: { ...baseStructurizerResult.structuredTask, qualityBar: 'fast' } },
      { ...baseRouteDecision, route: 'simple' },
      undefined,
      undefined,
      {
        retryPolicy: {
          maxRetries: 2,
          backoffStrategy: 'exponential',
          baseDelayMs: 100,
          maxDelayMs: 150,
        },
        onRetryAttempt,
        sleep,
      },
    );

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('retry success');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(onRetryAttempt).toHaveBeenCalledTimes(2);
    expect(onRetryAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attempt: 1,
        nextAttempt: 2,
        delayMs: 100,
        maxRetries: 2,
        backoffStrategy: 'exponential',
        error: expect.objectContaining({
          code: 'rate_limit',
        }),
      }),
    );
    expect(onRetryAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attempt: 2,
        nextAttempt: 3,
        delayMs: 150,
        maxRetries: 2,
        backoffStrategy: 'exponential',
        error: expect.objectContaining({
          code: 'timeout',
        }),
      }),
    );
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 150);
  });
});