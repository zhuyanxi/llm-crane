import { describe, expect, it } from 'vitest';
import { TaskResponseSchema, type TaskResponse } from '@llm-crane/schemas';
import type { ModelOverrideCatalog } from '../src/modelOverride';
import {
  annotateUpgradeResponse,
  buildVerificationActionRerunRequest,
  buildVerificationInsight,
  createVerificationDecisionResponse,
} from '../src/verificationActions';

const modelOverrideCatalog: ModelOverrideCatalog = {
  available: true,
  defaultSimpleModel: 'gpt-4.1-mini',
  defaultComplexModel: 'claude-3-5-sonnet-latest',
  options: [
    {
      modelId: 'gpt-4.1-mini',
      providerId: 'openai',
      runtimeId: 'openai',
      deploymentMode: 'hosted',
      apiFamily: 'openai-compatible',
      capabilityTier: 'fast',
      isDefaultSimple: true,
      isDefaultComplex: false,
      label: 'gpt-4.1-mini · openai',
      detail: 'hosted · provider=openai',
    },
    {
      modelId: 'claude-3-5-sonnet-latest',
      providerId: 'anthropic',
      runtimeId: 'anthropic',
      deploymentMode: 'hosted',
      apiFamily: 'anthropic',
      capabilityTier: 'high',
      isDefaultSimple: false,
      isDefaultComplex: true,
      label: 'claude-3-5-sonnet-latest · anthropic',
      detail: 'hosted · provider=anthropic',
    },
  ],
};

function createTaskResponse(overrides?: {
  modelId?: string;
  suggestedAction?: 'proceed' | 'retry' | 'upgrade-model' | 'manual-confirm';
  verdict?: 'pass' | 'fail' | 'warning';
  totalCostUsd?: number;
}): TaskResponse {
  const modelId = overrides?.modelId ?? 'gpt-4.1-mini';
  const totalCostUsd = overrides?.totalCostUsd ?? 0.001;
  const trace = [
    {
      stage: 'verifier.finish',
      status: 'completed' as const,
      timestamp: '2026-05-09T10:00:00.000Z',
      detail: 'Verifier completed.',
      metadata: {},
    },
  ];
  const pipeline = {
    version: 'v1' as const,
    graph: 'complex-v1' as const,
    route: 'complex' as const,
    state: 'completed' as const,
    stages: [
      {
        stageId: 'request' as const,
        label: 'Request Intake',
        state: 'completed' as const,
        dependsOn: [],
        startedAt: '2026-05-09T09:59:59.000Z',
        completedAt: '2026-05-09T09:59:59.010Z',
      },
      {
        stageId: 'executor' as const,
        label: 'Executor',
        state: 'completed' as const,
        dependsOn: ['reasoner'],
        startedAt: '2026-05-09T09:59:59.100Z',
        completedAt: '2026-05-09T09:59:59.900Z',
      },
      {
        stageId: 'verifier' as const,
        label: 'Verifier',
        state: 'completed' as const,
        dependsOn: ['executor'],
        startedAt: '2026-05-09T09:59:59.900Z',
        completedAt: '2026-05-09T10:00:00.000Z',
      },
      {
        stageId: 'response' as const,
        label: 'Response Assembly',
        state: 'completed' as const,
        dependsOn: ['verifier'],
        startedAt: '2026-05-09T10:00:00.000Z',
        completedAt: '2026-05-09T10:00:00.010Z',
      },
    ],
    transitions: [],
  };

  return TaskResponseSchema.parse({
    output: '1. Ship V1-S16 verification handling.',
    runInfo: {
      mode: 'full',
      reusedCheckpointStages: [],
      historyTraceCount: 0,
      historyTransitionCount: 0,
      detail: 'Full run completed.',
    },
    routeDecision: {
      status: 'routed',
      route: 'complex',
      reason: 'Complex request with verification hooks.',
      confidence: 0.86,
      complexityScore: 11,
      scoreBreakdown: [],
      strategy: 'rules-v1',
    },
    plannerResult: {
      status: 'planned',
      summary: 'Plan verification failure handling.',
      steps: [
        {
          stepId: 'step-1',
          title: 'Add verification panel',
          objective: 'Show verifier reasons and actions.',
          acceptance: 'Reasons and actions visible in result panel.',
        },
      ],
      decisionPoints: [],
      openQuestions: [],
      downstreamHints: {
        reasonerFocus: [],
        verifierChecks: ['verification-failure-actions'],
      },
      warnings: [],
    },
    reasonerResult: {
      status: 'reasoned',
      needReasoning: true,
      decisionSource: 'router+planner',
      summary: 'Verifier failure should stay visible after rerun.',
      keyEvidence: ['Verifier suggested follow-up action.'],
      warnings: [],
    },
    verifierResult: {
      verifierId: 'composite-verifier-v1',
      verifierKind: 'composite',
      verdict: overrides?.verdict ?? 'fail',
      summary: 'Composite verifier failed numbered-list check.',
      reasons: ['Output did not satisfy explicit numbered list requirement.'],
      suggestedAction: overrides?.suggestedAction ?? 'upgrade-model',
      findings: [
        {
          code: 'format_numbered_list_missing',
          summary: 'Numbered list rule failed.',
          detail: 'Expected at least one numbered item.',
          severity: 'fail',
          verifierId: 'rule-output-format-v1',
          verifierKind: 'rule',
        },
      ],
    },
    selectedProvider: {
      providerId: modelId.startsWith('claude') ? 'anthropic' : 'openai',
      runtimeId: modelId.startsWith('claude') ? 'anthropic' : 'openai',
      deploymentMode: 'hosted',
      apiFamily: modelId.startsWith('claude') ? 'anthropic' : 'openai-compatible',
      modelId,
      reason: 'Router selected configured default model.',
      confidence: 0.78,
    },
    providerResult: {
      status: 'completed',
      providerId: modelId.startsWith('claude') ? 'anthropic' : 'openai',
      modelId,
      outputText: '1. Ship V1-S16 verification handling.',
      stopReason: 'completed',
      usage: {
        inputTokens: 240,
        outputTokens: 120,
        totalTokens: 360,
      },
      latencyMs: 820,
    },
    costEstimate: {
      status: 'exact',
      currency: 'USD',
      pricingUnit: 'usd-per-1m-tokens',
      modelId,
      usageSource: 'provider',
      pricingSource: 'catalog',
      inputTokens: 240,
      outputTokens: 120,
      totalTokens: 360,
      inputCostUsd: totalCostUsd / 2,
      outputCostUsd: totalCostUsd / 2,
      totalCostUsd,
      latencyMs: 820,
      detail: 'Exact provider usage available.',
    },
    cacheInfo: {
      status: 'miss',
      key: 'task:verification-actions',
      storage: 'sqlite',
      detail: 'Fresh run.',
    },
    pipeline,
    trace,
    checkpoint: {
      taskRequest: {
        task: 'Implement verification failure handling.',
        qualityBar: 'balanced',
        cacheMode: 'default',
        contexts: [],
        constraints: ['Return numbered list.'],
      },
      routeDecision: {
        status: 'routed',
        route: 'complex',
        reason: 'Complex request with verification hooks.',
        confidence: 0.86,
        complexityScore: 11,
        scoreBreakdown: [],
        strategy: 'rules-v1',
      },
      plannerResult: {
        status: 'planned',
        summary: 'Plan verification failure handling.',
        steps: [
          {
            stepId: 'step-1',
            title: 'Add verification panel',
            objective: 'Show verifier reasons and actions.',
            acceptance: 'Reasons and actions visible in result panel.',
          },
        ],
        decisionPoints: [],
        openQuestions: [],
        downstreamHints: {
          reasonerFocus: [],
          verifierChecks: ['verification-failure-actions'],
        },
        warnings: [],
      },
      reasonerResult: {
        status: 'reasoned',
        needReasoning: true,
        decisionSource: 'router+planner',
        summary: 'Verifier failure should stay visible after rerun.',
        keyEvidence: ['Verifier suggested follow-up action.'],
        warnings: [],
      },
      verifierResult: {
        verifierId: 'composite-verifier-v1',
        verifierKind: 'composite',
        verdict: overrides?.verdict ?? 'fail',
        summary: 'Composite verifier failed numbered-list check.',
        reasons: ['Output did not satisfy explicit numbered list requirement.'],
        suggestedAction: overrides?.suggestedAction ?? 'upgrade-model',
        findings: [
          {
            code: 'format_numbered_list_missing',
            summary: 'Numbered list rule failed.',
            detail: 'Expected at least one numbered item.',
            severity: 'fail',
            verifierId: 'rule-output-format-v1',
            verifierKind: 'rule',
          },
        ],
      },
      output: '1. Ship V1-S16 verification handling.',
      providerResult: {
        status: 'completed',
        providerId: modelId.startsWith('claude') ? 'anthropic' : 'openai',
        modelId,
        outputText: '1. Ship V1-S16 verification handling.',
        stopReason: 'completed',
        usage: {
          inputTokens: 240,
          outputTokens: 120,
          totalTokens: 360,
        },
        latencyMs: 820,
      },
      costEstimate: {
        status: 'exact',
        currency: 'USD',
        pricingUnit: 'usd-per-1m-tokens',
        modelId,
        usageSource: 'provider',
        pricingSource: 'catalog',
        inputTokens: 240,
        outputTokens: 120,
        totalTokens: 360,
        inputCostUsd: totalCostUsd / 2,
        outputCostUsd: totalCostUsd / 2,
        totalCostUsd,
        latencyMs: 820,
        detail: 'Exact provider usage available.',
      },
      pipeline,
      trace,
      capturedAt: '2026-05-09T10:00:00.010Z',
    },
  });
}

describe('verificationActions', () => {
  it('builds upgrade and manual-confirm actions for upgrade-model verifier result', () => {
    const insight = buildVerificationInsight(createTaskResponse(), modelOverrideCatalog);

    expect(insight.summary).toBe('fail · composite');
    expect(insight.suggestedActionLabel).toBe('Model upgrade suggested');
    expect(insight.actions.map((action) => action.actionId)).toEqual(['upgrade-model', 'manual-confirm']);
    expect(insight.actions[0]?.label).toContain('claude-3-5-sonnet-latest');
  });

  it('falls back to manual confirmation when already on complex default model', () => {
    const insight = buildVerificationInsight(
      createTaskResponse({ modelId: 'claude-3-5-sonnet-latest' }),
      modelOverrideCatalog,
    );

    expect(insight.actions.map((action) => action.actionId)).toEqual(['manual-confirm']);
    expect(insight.detail).toContain('Upgrade unavailable');
  });

  it('builds executor rerun request for retry action with appended trace event', () => {
    const rerunRequest = buildVerificationActionRerunRequest(
      createTaskResponse({ suggestedAction: 'retry' }),
      'retry',
      modelOverrideCatalog,
      () => '2026-05-09T10:05:00.000Z',
    );

    expect(rerunRequest.targetStageId).toBe('executor');
    expect(rerunRequest.checkpoint.trace.at(-1)).toMatchObject({
      stage: 'verification.retry.requested',
      status: 'retrying',
      timestamp: '2026-05-09T10:05:00.000Z',
    });
  });

  it('records declined automatic upgrade in trace and checkpoint trace', () => {
    const response = createVerificationDecisionResponse(
      createTaskResponse(),
      'upgrade-declined',
      modelOverrideCatalog,
      () => '2026-05-09T10:06:00.000Z',
    );

    expect(response.trace.at(-1)).toMatchObject({
      stage: 'verification.upgrade.declined',
      status: 'skipped',
      timestamp: '2026-05-09T10:06:00.000Z',
    });
    expect(response.checkpoint.trace.at(-1)?.stage).toBe('verification.upgrade.declined');
  });

  it('annotates upgrade rerun with extra cost delta', () => {
    const annotated = annotateUpgradeResponse(
      createTaskResponse({ totalCostUsd: 0.001, modelId: 'gpt-4.1-mini' }),
      createTaskResponse({ totalCostUsd: 0.003, modelId: 'claude-3-5-sonnet-latest' }),
      () => '2026-05-09T10:07:00.000Z',
    );

    expect(annotated.trace.at(-1)).toMatchObject({
      stage: 'verification.upgrade.cost',
      status: 'completed',
      timestamp: '2026-05-09T10:07:00.000Z',
    });
    expect(annotated.trace.at(-1)?.metadata.extraCostUsd).toBe(0.002);
    expect(annotated.trace.at(-1)?.detail).toContain('$0.0020');
  });
});