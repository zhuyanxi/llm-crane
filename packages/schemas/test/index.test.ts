import { describe, expect, it } from 'vitest';
import { BUILT_IN_TASK_TEMPLATES, OrchestratorEventSchema, OrchestratorRequestSchema, RuntimeConfigSchema, TaskRequestSchema } from '../src/index';

describe('TaskRequestSchema', () => {
  it('parses minimal task request', () => {
    const parsed = TaskRequestSchema.parse({
      task: 'Summarize current file',
    });

    expect(parsed.qualityBar).toBe('balanced');
    expect(parsed.cacheMode).toBe('default');
    expect(parsed.contexts).toEqual([]);
  });

  it('rejects empty task', () => {
    expect(() => TaskRequestSchema.parse({ task: '' })).toThrow();
  });

  it('parses task template metadata', () => {
    const parsed = TaskRequestSchema.parse({
      task: 'Refactor task\nTarget code: src/auth.ts\nRefactor goal: reduce duplication',
      taskType: 'refactor',
      taskTemplate: {
        templateId: 'refactor',
        values: {
          target: 'src/auth.ts',
          goal: 'reduce duplication',
        },
      },
      constraints: ['Keep public API stable unless change is explicitly requested.'],
    });

    expect(parsed.taskTemplate?.templateId).toBe('refactor');
    expect(parsed.taskTemplate?.values.goal).toBe('reduce duplication');
  });

  it('adds default context priority metadata when contexts are provided', () => {
    const parsed = TaskRequestSchema.parse({
      task: 'Review current file',
      contexts: [
        {
          source: 'file',
          uri: '/workspace/src/app.ts',
          languageId: 'typescript',
          content: 'export const value = 1;',
        },
      ],
    });

    expect(parsed.contexts[0]?.priority).toBe('primary');
    expect(parsed.contexts[0]?.truncated).toBe(false);
  });
});

describe('built-in task template metadata', () => {
  it('includes context strategy for each built-in template', () => {
    for (const template of BUILT_IN_TASK_TEMPLATES) {
      expect(template.contextStrategy.maxChars).toBeGreaterThan(0);
      expect(['selection-first', 'file-first', 'manual-only']).toContain(template.contextStrategy.mode);
    }
  });
});

describe('RuntimeConfigSchema', () => {
  it('requires known transport', () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        defaultSimpleModel: 'gpt-4o-mini',
        defaultComplexModel: 'claude-3-5-sonnet-latest',
        transport: 'http',
        logLevel: 'info',
        providerKeys: {},
      }),
    ).toThrow();
  });

  it('parses local runtime profile descriptors', () => {
    const parsed = RuntimeConfigSchema.parse({
      defaultSimpleModel: 'local-qwen2.5-coder',
      defaultComplexModel: 'claude-3-5-sonnet-latest',
      transport: 'stdio',
      logLevel: 'info',
      providerKeys: {
        anthropic: 'sk-anthropic',
      },
      runtimeProfiles: [
        {
          runtimeId: 'lmstudio-local',
          providerId: 'openai',
          deploymentMode: 'local',
          apiFamily: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1234/v1',
          models: ['local-qwen2.5-coder'],
          authMode: 'header',
          authToken: 'lmstudio-secret',
          authHeaderName: 'X-LM-Studio-Key',
          headers: {
            'X-Client': 'llm-crane',
          },
          timeoutMs: 45000,
        },
        {
          runtimeId: 'ollama-local',
          providerId: 'ollama',
          deploymentMode: 'local',
          apiFamily: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          models: ['qwen2.5-coder:7b'],
          authMode: 'none',
          timeoutMs: 30000,
        },
      ],
    });

    expect(parsed.runtimeProfiles[0]?.runtimeId).toBe('lmstudio-local');
    expect(parsed.runtimeProfiles[0]?.deploymentMode).toBe('local');
    expect(parsed.runtimeProfiles[0]?.apiFamily).toBe('openai-compatible');
    expect(parsed.runtimeProfiles[0]?.authMode).toBe('header');
    expect(parsed.runtimeProfiles[0]?.authHeaderName).toBe('X-LM-Studio-Key');
    expect(parsed.runtimeProfiles[0]?.headers).toEqual({ 'X-Client': 'llm-crane' });
    expect(parsed.runtimeProfiles[1]?.providerId).toBe('ollama');
    expect(parsed.runtimeProfiles[1]?.apiFamily).toBe('ollama');
  });
});

describe('Orchestrator protocol schemas', () => {
  it('parses runTask request envelope', () => {
    const parsed = OrchestratorRequestSchema.parse({
      id: 'req-1',
      type: 'runTask',
      request: {
        task: 'Review selection',
        cacheMode: 'bypass',
        contexts: [
          {
            source: 'selection',
            content: 'const value = 1;',
            languageId: 'typescript',
          },
        ],
      },
    });

    expect(parsed.type).toBe('runTask');
    if (parsed.type !== 'runTask') {
      throw new Error('Expected runTask envelope');
    }

    expect(parsed.request.cacheMode).toBe('bypass');
  });

  it('parses rerunTask request envelope', () => {
    const parsed = OrchestratorRequestSchema.parse({
      id: 'req-2',
      type: 'rerunTask',
      rerun: {
        targetStageId: 'planner',
        checkpoint: {
          taskRequest: {
            task: 'Review selection',
            cacheMode: 'default',
            contexts: [
              {
                source: 'selection',
                content: 'const value = 1;',
                languageId: 'typescript',
              },
            ],
          },
          routeDecision: {
            status: 'routed',
            route: 'complex',
            reason: 'Need planner.',
            confidence: 0.7,
            complexityScore: 6,
            scoreBreakdown: [],
            strategy: 'rules-v1',
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
          capturedAt: '2026-05-05T00:00:04.000Z',
        },
      },
    });

    expect(parsed.type).toBe('rerunTask');
    if (parsed.type !== 'rerunTask') {
      throw new Error('Expected rerunTask envelope');
    }

    expect(parsed.rerun.targetStageId).toBe('planner');
  });

  it('parses taskResult event envelope', () => {
    const parsed = OrchestratorEventSchema.parse({
      id: 'req-1',
      type: 'taskResult',
      response: {
        output: 'Task received.',
        runInfo: {
          mode: 'full',
          reusedCheckpointStages: [],
          historyTraceCount: 0,
          historyTransitionCount: 0,
          detail: 'Full pipeline run.',
        },
        routeDecision: {
          status: 'routed',
          route: 'simple',
          reason: 'Narrow selection with low ambiguity.',
          confidence: 0.82,
          complexityScore: 2,
          scoreBreakdown: [
            {
              factor: 'target-scope',
              score: 0,
              detail: 'Selection target keeps task narrow.',
            },
          ],
          strategy: 'rules-v1',
        },
        selectedProvider: {
          providerId: 'openai',
          runtimeId: 'lmstudio-local',
          deploymentMode: 'local',
          apiFamily: 'openai-compatible',
          modelId: 'gpt-4o-mini',
          reason: 'Lifecycle probe.',
        },
        providerResult: {
          status: 'completed',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          outputText: 'Task received.',
          latencyMs: 120,
        },
        costEstimate: {
          status: 'unknown',
          currency: 'USD',
          pricingUnit: 'usd-per-1m-tokens',
          modelId: 'gpt-4o-mini',
          usageSource: 'provider',
          pricingSource: 'unknown',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          latencyMs: 120,
          detail: 'Local runtime lmstudio-local pricing unavailable in V0; token usage shown without cost estimate.',
        },
        diagnostic: {
          category: 'provider',
          code: 'provider.network',
          summary: 'Local runtime unavailable',
          message: 'fetch failed',
          providerId: 'openai',
          runtimeId: 'lmstudio-local',
          deploymentMode: 'local',
          apiFamily: 'openai-compatible',
        },
        trace: [
          {
            stage: 'executor.start',
            status: 'completed',
            timestamp: '2026-05-05T00:00:00.000Z',
            metadata: {
              runtimeId: 'lmstudio-local',
              deploymentMode: 'local',
              requestId: 'req-1',
            },
          },
        ],
        pipeline: {
          version: 'v1',
          graph: 'simple-v1',
          route: 'simple',
          state: 'completed',
          stages: [
            {
              stageId: 'request',
              label: 'Request Intake',
              state: 'completed',
              dependsOn: [],
              input: {
                stageId: 'request',
                taskChars: 12,
                contextCount: 1,
                constraintCount: 0,
                qualityBar: 'balanced',
              },
              output: {
                stageId: 'request',
                accepted: true,
              },
              startedAt: '2026-05-05T00:00:00.000Z',
              completedAt: '2026-05-05T00:00:00.000Z',
            },
            {
              stageId: 'structurizer',
              label: 'Structurizer',
              state: 'completed',
              dependsOn: ['request'],
              input: {
                stageId: 'structurizer',
                taskChars: 12,
                contextCount: 1,
              },
              output: {
                stageId: 'structurizer',
                status: 'structured',
                taskType: 'analysis',
                targetKind: 'file',
                warningCount: 0,
              },
              startedAt: '2026-05-05T00:00:00.000Z',
              completedAt: '2026-05-05T00:00:01.000Z',
            },
            {
              stageId: 'router',
              label: 'Router',
              state: 'completed',
              dependsOn: ['structurizer'],
              input: {
                stageId: 'router',
                structurizerStatus: 'structured',
                taskType: 'analysis',
                openQuestions: 0,
                warningCount: 0,
              },
              output: {
                stageId: 'router',
                status: 'routed',
                route: 'simple',
                complexityScore: 2,
                confidence: 0.82,
              },
              startedAt: '2026-05-05T00:00:01.000Z',
              completedAt: '2026-05-05T00:00:02.000Z',
            },
            {
              stageId: 'executor',
              label: 'Executor',
              state: 'completed',
              dependsOn: ['router'],
              input: {
                stageId: 'executor',
                route: 'simple',
                providerId: 'openai',
                modelId: 'gpt-4o-mini',
                runtimeId: 'lmstudio-local',
                deploymentMode: 'local',
                apiFamily: 'openai-compatible',
              },
              output: {
                stageId: 'executor',
                status: 'completed',
                providerId: 'openai',
                modelId: 'gpt-4o-mini',
                latencyMs: 120,
              },
              startedAt: '2026-05-05T00:00:02.000Z',
              completedAt: '2026-05-05T00:00:03.000Z',
            },
            {
              stageId: 'response',
              label: 'Response Assembly',
              state: 'completed',
              dependsOn: ['executor'],
              input: {
                stageId: 'response',
                providerStatus: 'completed',
                costStatus: 'unknown',
                diagnosticPresent: true,
              },
              output: {
                stageId: 'response',
                outputChars: 14,
                providerStatus: 'completed',
                costStatus: 'unknown',
                diagnosticCode: 'provider.network',
              },
              startedAt: '2026-05-05T00:00:03.000Z',
              completedAt: '2026-05-05T00:00:04.000Z',
            },
          ],
          transitions: [
            {
              stageId: 'request',
              fromState: 'pending',
              toState: 'running',
              timestamp: '2026-05-05T00:00:00.000Z',
            },
            {
              stageId: 'request',
              fromState: 'running',
              toState: 'completed',
              timestamp: '2026-05-05T00:00:00.000Z',
            },
          ],
        },
        checkpoint: {
          taskRequest: {
            task: 'Review selection',
            cacheMode: 'default',
            contexts: [
              {
                source: 'selection',
                content: 'const value = 1;',
                languageId: 'typescript',
              },
            ],
          },
          routeDecision: {
            status: 'routed',
            route: 'simple',
            reason: 'Narrow selection with low ambiguity.',
            confidence: 0.82,
            complexityScore: 2,
            scoreBreakdown: [
              {
                factor: 'target-scope',
                score: 0,
                detail: 'Selection target keeps task narrow.',
              },
            ],
            strategy: 'rules-v1',
          },
          pipeline: {
            version: 'v1',
            graph: 'simple-v1',
            route: 'simple',
            state: 'completed',
            stages: [
              {
                stageId: 'request',
                label: 'Request Intake',
                state: 'completed',
                dependsOn: [],
                input: {
                  stageId: 'request',
                  taskChars: 12,
                  contextCount: 1,
                  constraintCount: 0,
                  qualityBar: 'balanced',
                },
                output: {
                  stageId: 'request',
                  accepted: true,
                },
                startedAt: '2026-05-05T00:00:00.000Z',
                completedAt: '2026-05-05T00:00:00.000Z',
              },
            ],
            transitions: [],
          },
          trace: [
            {
              stage: 'executor.start',
              status: 'completed',
              timestamp: '2026-05-05T00:00:00.000Z',
              metadata: {
                runtimeId: 'lmstudio-local',
                deploymentMode: 'local',
                requestId: 'req-1',
              },
            },
          ],
          capturedAt: '2026-05-05T00:00:04.000Z',
        },
      },
    });

    expect(parsed.type).toBe('taskResult');
    if (parsed.type !== 'taskResult') {
      throw new Error('Expected taskResult envelope');
    }

    expect(parsed.response.selectedProvider.runtimeId).toBe('lmstudio-local');
    expect(parsed.response.selectedProvider.deploymentMode).toBe('local');
    expect(parsed.response.diagnostic?.runtimeId).toBe('lmstudio-local');
    expect(parsed.response.costEstimate.pricingSource).toBe('unknown');
    expect(parsed.response.pipeline.graph).toBe('simple-v1');
  });

  it('parses error event envelope with diagnostic payload', () => {
    const parsed = OrchestratorEventSchema.parse({
      type: 'error',
      id: 'req-2',
      message: 'Provider failed',
      diagnostic: {
        category: 'provider',
        code: 'provider.network',
        summary: 'Local runtime unavailable',
        message: 'fetch failed',
        providerId: 'openai',
        runtimeId: 'lmstudio-local',
        deploymentMode: 'local',
        apiFamily: 'openai-compatible',
        stage: 'executor.invoke',
      },
    });

    expect(parsed.type).toBe('error');
    if (parsed.type !== 'error') {
      throw new Error('Expected error envelope');
    }

    expect(parsed.diagnostic?.runtimeId).toBe('lmstudio-local');
    expect(parsed.diagnostic?.deploymentMode).toBe('local');
  });
});