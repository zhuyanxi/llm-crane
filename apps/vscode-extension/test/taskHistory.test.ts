import { describe, expect, it } from 'vitest';
import type { TaskResponse } from '@llm-crane/schemas';
import { buildTaskHistoryEntryView } from '../src/taskHistory';

describe('buildTaskHistoryEntryView', () => {
  it('builds history summary for automatic full run', () => {
    const historyEntry = buildTaskHistoryEntryView(
      'run-1',
      'Refactor auth handler to reduce duplication without changing behavior',
      {
        routeDecision: {
          status: 'routed',
          route: 'simple',
          reason: 'Bounded change',
          confidence: 0.82,
          complexityScore: 2,
          scoreBreakdown: [],
          strategy: 'rules-v1',
        },
        selectedProvider: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          reason: 'Bounded change',
        },
        runInfo: {
          mode: 'full',
          reusedCheckpointStages: [],
          historyTraceCount: 0,
          historyTransitionCount: 0,
          detail: 'Full pipeline run.',
        },
        cacheInfo: {
          status: 'hit',
          key: 'abc',
          storage: 'sqlite',
          detail: 'cache hit',
        },
        providerResult: {
          status: 'completed',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          outputText: 'done',
        },
        checkpoint: {
          taskRequest: {
            task: 'Refactor auth handler',
            qualityBar: 'balanced',
            cacheMode: 'default',
            contexts: [],
            constraints: [],
          },
          pipeline: {
            version: 'v1',
            graph: 'simple-v1',
            route: 'simple',
            state: 'completed',
            stages: [],
            transitions: [],
          },
          trace: [],
          capturedAt: '2026-05-08T12:00:00.000Z',
        },
        trace: [{
          stage: 'pipeline.finish',
          status: 'completed',
          timestamp: '2026-05-08T12:00:00.000Z',
          metadata: {},
        }],
      } satisfies Pick<TaskResponse, 'routeDecision' | 'selectedProvider' | 'runInfo' | 'cacheInfo' | 'providerResult' | 'checkpoint' | 'trace'>,
    );

    expect(historyEntry.title).toContain('Refactor auth handler');
    expect(historyEntry.summary).toBe('simple route · openai/gpt-4o-mini');
    expect(historyEntry.detail).toContain('trace=1');
    expect(historyEntry.tags).toEqual(['simple', 'cache:hit', 'full']);
  });

  it('marks rerun, override, and failed history tags', () => {
    const historyEntry = buildTaskHistoryEntryView(
      'run-2',
      'Analyze workspace architecture risk and compare two model choices',
      {
        routeDecision: {
          status: 'routed',
          route: 'complex',
          reason: 'Wide scope',
          confidence: 0.61,
          complexityScore: 8,
          scoreBreakdown: [],
          strategy: 'rules-v1',
        },
        selectedProvider: {
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet-latest',
          reason: 'Manual override pinned execution.',
        },
        runInfo: {
          mode: 'stage-rerun',
          targetStageId: 'reasoner',
          reusedCheckpointStages: ['structurizer', 'router', 'planner'],
          historyTraceCount: 12,
          historyTransitionCount: 8,
          detail: 'Stage rerun resumed from reasoner.',
        },
        cacheInfo: {
          status: 'bypassed',
          key: 'def',
          storage: 'sqlite',
          detail: 'cache bypassed',
        },
        providerResult: {
          status: 'failed',
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet-latest',
          outputText: '',
          error: {
            providerId: 'anthropic',
            code: 'timeout',
            message: 'timeout',
            retriable: true,
          },
        },
        diagnostic: {
          category: 'provider',
          code: 'provider.timeout',
          summary: 'Provider timeout',
          message: 'timeout',
        },
        checkpoint: {
          taskRequest: {
            task: 'Analyze workspace architecture risk',
            qualityBar: 'high',
            cacheMode: 'bypass',
            contexts: [],
            constraints: [],
            policyOverrides: {
              modelOverride: {
                mode: 'specific',
                modelId: 'claude-3-5-sonnet-latest',
              },
            },
          },
          pipeline: {
            version: 'v1',
            graph: 'complex-v1',
            route: 'complex',
            state: 'failed',
            stages: [],
            transitions: [],
          },
          trace: [],
          capturedAt: '2026-05-08T12:05:00.000Z',
        },
        trace: [
          {
            stage: 'policy.override',
            status: 'completed',
            timestamp: '2026-05-08T12:05:00.000Z',
            metadata: { mode: 'specific' },
          },
          {
            stage: 'executor.invoke',
            status: 'failed',
            timestamp: '2026-05-08T12:05:01.000Z',
            metadata: {},
            error: {
              code: 'timeout',
              message: 'timeout',
            },
          },
        ],
      } satisfies Pick<TaskResponse, 'routeDecision' | 'selectedProvider' | 'runInfo' | 'cacheInfo' | 'providerResult' | 'diagnostic' | 'checkpoint' | 'trace'>,
    );

    expect(historyEntry.summary).toBe('complex route · anthropic/claude-3-5-sonnet-latest');
    expect(historyEntry.detail).toContain('rerun from reasoner');
    expect(historyEntry.tags).toEqual(['complex', 'cache:bypassed', 'rerun:reasoner', 'override', 'failed']);
  });

  it('surfaces verifier failure tags even when provider execution succeeded', () => {
    const historyEntry = buildTaskHistoryEntryView(
      'run-3',
      'Return a numbered list that satisfies verifier checks',
      {
        routeDecision: {
          status: 'routed',
          route: 'complex',
          reason: 'Verifier-enforced output format.',
          confidence: 0.8,
          complexityScore: 9,
          scoreBreakdown: [],
          strategy: 'rules-v1',
        },
        selectedProvider: {
          providerId: 'openai',
          modelId: 'gpt-4.1-mini',
          reason: 'Complex default selected.',
        },
        runInfo: {
          mode: 'full',
          reusedCheckpointStages: [],
          historyTraceCount: 0,
          historyTransitionCount: 0,
          detail: 'Full pipeline run.',
        },
        cacheInfo: {
          status: 'miss',
          key: 'ghi',
          storage: 'sqlite',
          detail: 'cache miss',
        },
        providerResult: {
          status: 'completed',
          providerId: 'openai',
          modelId: 'gpt-4.1-mini',
          outputText: 'plain paragraph output',
        },
        verifierResult: {
          verifierId: 'composite-verifier-v1',
          verifierKind: 'composite',
          verdict: 'fail',
          summary: 'Numbered list missing.',
          reasons: ['Output did not satisfy numbered list requirement.'],
          suggestedAction: 'retry',
          findings: [],
        },
        checkpoint: {
          taskRequest: {
            task: 'Return numbered list',
            qualityBar: 'balanced',
            cacheMode: 'default',
            contexts: [],
            constraints: ['Return numbered list.'],
          },
          pipeline: {
            version: 'v1',
            graph: 'complex-v1',
            route: 'complex',
            state: 'completed',
            stages: [],
            transitions: [],
          },
          trace: [],
          capturedAt: '2026-05-08T12:10:00.000Z',
        },
        trace: [
          {
            stage: 'verifier.finish',
            status: 'completed',
            timestamp: '2026-05-08T12:10:00.000Z',
            metadata: {},
          },
        ],
      } satisfies Pick<TaskResponse, 'routeDecision' | 'selectedProvider' | 'runInfo' | 'cacheInfo' | 'providerResult' | 'verifierResult' | 'checkpoint' | 'trace'>,
    );

    expect(historyEntry.tags).toEqual(['complex', 'cache:miss', 'full', 'verify:fail', 'failed']);
  });
});