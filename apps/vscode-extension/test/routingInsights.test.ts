import { describe, expect, it } from 'vitest';
import type { TaskResponse } from '@llm-crane/schemas';
import { buildRoutingInsight } from '../src/routingInsights';

describe('buildRoutingInsight', () => {
  it('shows automatic simple-route explanation and saved complex-only stages', () => {
    const insight = buildRoutingInsight({
      routeDecision: {
        status: 'routed',
        route: 'simple',
        reason: 'Small bounded bug fix stays on cheap path.',
        confidence: 0.78,
        complexityScore: 3,
        scoreBreakdown: [],
        strategy: 'rules-v1',
      },
      reasonerResult: {
        status: 'skipped',
        needReasoning: false,
        decisionSource: 'router',
        summary: 'Early exit: executor can proceed without extra reasoning for debug on src/auth.ts.',
        keyEvidence: [],
        earlyExitReason: 'Router chose simple path, so extra reasoning would be redundant.',
        warnings: [],
      },
      pipeline: {
        version: 'v1',
        graph: 'simple-v1',
        route: 'simple',
        state: 'completed',
        stages: [
          { stageId: 'request', label: 'Request Intake', state: 'completed', dependsOn: [] },
          { stageId: 'structurizer', label: 'Structurizer', state: 'completed', dependsOn: ['request'] },
          { stageId: 'router', label: 'Router', state: 'completed', dependsOn: ['structurizer'] },
          { stageId: 'executor', label: 'Executor', state: 'completed', dependsOn: ['router'] },
          { stageId: 'response', label: 'Response Assembly', state: 'completed', dependsOn: ['executor'] },
        ],
        transitions: [],
      },
      checkpoint: {
        taskRequest: {
          task: 'debug auth refresh bug',
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
        capturedAt: '2026-05-08T10:00:00.000Z',
      },
    } satisfies Pick<TaskResponse, 'routeDecision' | 'reasonerResult' | 'pipeline' | 'checkpoint'>);

    expect(insight.routeSummary).toBe('simple route · routed');
    expect(insight.routeDetail).toContain('78% confidence');
    expect(insight.overrideSummary).toBe('Automatic routing');
    expect(insight.earlyExitSummary).toBe('Saved planner, reasoner, verifier');
    expect(insight.earlyExitDetail).toContain('extra reasoning would be redundant');
  });

  it('shows manual override and skipped complex stage names when policy overrides exist', () => {
    const insight = buildRoutingInsight({
      routeDecision: {
        status: 'fallback',
        route: 'complex',
        reason: 'Open questions keep task on conservative path.',
        confidence: 0.42,
        complexityScore: 9,
        scoreBreakdown: [],
        strategy: 'safe-fallback',
        fallbackReason: 'Router output invalid, conservative path selected.',
      },
      reasonerResult: {
        status: 'skipped',
        needReasoning: false,
        decisionSource: 'planner',
        summary: 'Early exit: executor can proceed without extra reasoning for analysis on workspace.',
        keyEvidence: [],
        earlyExitReason: 'Planner found bounded path, so executor can proceed without extra reasoning.',
        warnings: [],
      },
      pipeline: {
        version: 'v1',
        graph: 'complex-v1',
        route: 'complex',
        state: 'completed',
        stages: [
          { stageId: 'planner', label: 'Planner', state: 'completed', dependsOn: ['router'] },
          {
            stageId: 'reasoner',
            label: 'Reasoner',
            state: 'skipped',
            dependsOn: ['planner'],
            skippedReason: 'Planner found bounded analysis path.',
          },
          {
            stageId: 'verifier',
            label: 'Verifier',
            state: 'skipped',
            dependsOn: ['reasoner'],
            skippedReason: 'Verifier not enabled in V1-S03.',
          },
        ],
        transitions: [],
      },
      checkpoint: {
        taskRequest: {
          task: 'analyze architecture risks',
          qualityBar: 'balanced',
          cacheMode: 'default',
          contexts: [],
          constraints: [],
          policyOverrides: {
            modelId: 'gpt-4.1',
          },
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
        capturedAt: '2026-05-08T10:00:00.000Z',
      },
    } satisfies Pick<TaskResponse, 'routeDecision' | 'reasonerResult' | 'pipeline' | 'checkpoint'>);

    expect(insight.overrideSummary).toBe('Manual override');
    expect(insight.overrideDetail).toContain('modelId');
    expect(insight.routeReason).toContain('Fallback: Router output invalid');
    expect(insight.earlyExitSummary).toBe('Saved reasoner and verifier');
  });
});