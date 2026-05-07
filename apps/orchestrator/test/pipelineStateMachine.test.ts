import { describe, expect, it } from 'vitest';
import type { StructurizerResult, TaskRequest } from '@llm-crane/schemas';
import {
  buildCachedPipelineState,
  createPipelineStateMachine,
  createRequestStageInput,
  createRequestStageOutput,
  createRouterStageInput,
  createRouterStageOutput,
  createStructurizerStageInput,
  createStructurizerStageOutput,
  createVerifierStageInput,
  createVerifierStageOutput,
} from '../src/pipelineStateMachine';

const baseTaskRequest: TaskRequest = {
  task: 'Review current file for stage transitions.',
  qualityBar: 'balanced',
  cacheMode: 'default',
  constraints: [],
  contexts: [
    {
      source: 'file',
      uri: '/workspace/src/app.ts',
      languageId: 'typescript',
      content: 'export const value = 1;',
    },
  ],
};

const structuredTaskResult: StructurizerResult = {
  status: 'structured',
  structuredTask: {
    originalTask: baseTaskRequest.task,
    taskType: 'analysis',
    goal: 'Review current file for stage transitions.',
    target: {
      kind: 'file',
      value: '/workspace/src/app.ts',
      uri: '/workspace/src/app.ts',
    },
    qualityBar: 'balanced',
    constraints: [],
    openQuestions: [],
    uncertaintyReasons: [],
    contextSummary: [],
  },
  warnings: [],
};

function createTimestampFactory() {
  let index = 0;
  return () => `2026-05-05T00:00:0${index++}.000Z`;
}

describe('PipelineStateMachine', () => {
  it('serializes simple graph stages and transitions', () => {
    const machine = createPipelineStateMachine(baseTaskRequest, createTimestampFactory());

    machine.startStage('request', createRequestStageInput(baseTaskRequest));
    machine.completeStage('request', createRequestStageOutput());
    machine.startStage('structurizer', createStructurizerStageInput(baseTaskRequest));
    machine.completeStage('structurizer', createStructurizerStageOutput(structuredTaskResult));
    machine.startStage('router', createRouterStageInput(structuredTaskResult));
    machine.completeStage('router', createRouterStageOutput({
      status: 'routed',
      route: 'simple',
      reason: 'Narrow file task.',
      confidence: 0.9,
      complexityScore: 2,
      scoreBreakdown: [],
      strategy: 'rules-v1',
    }));

    const serialized = machine.serialize();

    expect(serialized.graph).toBe('simple-v1');
    expect(serialized.state).toBe('pending');
    expect(serialized.stages.find((stage) => stage.stageId === 'router')?.state).toBe('completed');
    expect(serialized.transitions).toHaveLength(6);
  });

  it('upgrades to complex graph and preserves completed request stage', () => {
    const machine = createPipelineStateMachine(baseTaskRequest, createTimestampFactory());

    machine.startStage('request', createRequestStageInput(baseTaskRequest));
    machine.completeStage('request', createRequestStageOutput());
    machine.setGraph('complex');
    machine.skipStage('verifier', 'Verifier intentionally skipped for graph test.', createVerifierStageOutput('skipped', 'Verifier skipped.'), {
      input: createVerifierStageInput(
        {
          status: 'routed',
          route: 'complex',
          reason: 'Complex task.',
          confidence: 0.91,
          complexityScore: 12,
          scoreBreakdown: [],
          strategy: 'rules-v1',
        },
        true,
      ),
    });

    const serialized = machine.serialize();

    expect(serialized.graph).toBe('complex-v1');
    expect(serialized.stages.find((stage) => stage.stageId === 'request')?.state).toBe('completed');
    expect(serialized.stages.find((stage) => stage.stageId === 'planner')?.state).toBe('pending');
    expect(serialized.stages.find((stage) => stage.stageId === 'executor')?.dependsOn).toEqual(['verifier']);
    expect(serialized.stages.find((stage) => stage.stageId === 'verifier')?.state).toBe('skipped');
  });

  it('rejects invalid terminal transition', () => {
    const machine = createPipelineStateMachine(baseTaskRequest, createTimestampFactory());

    machine.startStage('request', createRequestStageInput(baseTaskRequest));
    machine.completeStage('request', createRequestStageOutput());

    expect(() => machine.startStage('request', createRequestStageInput(baseTaskRequest))).toThrow(
      'Invalid pipeline transition for request: completed -> running',
    );
  });

  it('builds cache-hit pipeline with skipped executor state', () => {
    const pipeline = buildCachedPipelineState(
      baseTaskRequest,
      {
        output: 'cached output',
        routeDecision: {
          status: 'routed',
          route: 'simple',
          reason: 'Narrow file task.',
          confidence: 0.8,
          complexityScore: 2,
          scoreBreakdown: [],
          strategy: 'rules-v1',
        },
        selectedProvider: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          reason: 'Fast path.',
          confidence: 0.8,
        },
        providerResult: {
          status: 'completed',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          outputText: 'cached output',
          latencyMs: 80,
        },
        costEstimate: {
          status: 'exact',
          currency: 'USD',
          pricingUnit: 'usd-per-1m-tokens',
          modelId: 'gpt-4o-mini',
          usageSource: 'provider',
          pricingSource: 'catalog',
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          totalCostUsd: 0.00001,
          detail: 'Cache-hit estimate.',
        },
        diagnostic: undefined,
      },
      createTimestampFactory(),
    );

    expect(pipeline.graph).toBe('simple-v1');
    expect(pipeline.state).toBe('completed');
    expect(pipeline.stages.find((stage) => stage.stageId === 'executor')?.state).toBe('skipped');
    expect(pipeline.stages.find((stage) => stage.stageId === 'response')?.state).toBe('completed');
  });
});