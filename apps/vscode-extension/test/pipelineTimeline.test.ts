import { describe, expect, it } from 'vitest';
import type { TaskResponse } from '@llm-crane/schemas';
import { buildPipelineTimeline } from '../src/pipelineTimeline';

describe('buildPipelineTimeline', () => {
  it('builds ordered timeline with duration and summary for completed complex stages', () => {
    const timeline = buildPipelineTimeline({
      pipeline: {
        version: 'v1',
        graph: 'complex-v1',
        route: 'complex',
        state: 'completed',
        currentStageId: undefined,
        stages: [
          {
            stageId: 'request',
            label: 'Request Intake',
            state: 'completed',
            dependsOn: [],
            startedAt: '2026-05-08T10:00:00.000Z',
            completedAt: '2026-05-08T10:00:00.010Z',
            output: { stageId: 'request', accepted: true },
          },
          {
            stageId: 'structurizer',
            label: 'Structurizer',
            state: 'completed',
            dependsOn: ['request'],
            startedAt: '2026-05-08T10:00:00.010Z',
            completedAt: '2026-05-08T10:00:00.040Z',
            output: {
              stageId: 'structurizer',
              status: 'structured',
              taskType: 'debug',
              targetKind: 'file',
              warningCount: 0,
              expectedOutputCount: 2,
              confidence: 0.84,
            },
          },
          {
            stageId: 'router',
            label: 'Router',
            state: 'completed',
            dependsOn: ['structurizer'],
            startedAt: '2026-05-08T10:00:00.040Z',
            completedAt: '2026-05-08T10:00:00.060Z',
            output: {
              stageId: 'router',
              status: 'routed',
              route: 'complex',
              complexityScore: 8,
              confidence: 0.75,
            },
          },
        ],
        transitions: [],
      },
      trace: [
        {
          stage: 'structurizer.finish',
          status: 'completed',
          timestamp: '2026-05-08T10:00:00.040Z',
          detail: 'Structurizer completed with expected output hints.',
          metadata: {},
        },
      ],
    } satisfies Pick<TaskResponse, 'pipeline' | 'trace'>);

    expect(timeline.map((stage) => stage.stageId)).toEqual(['request', 'structurizer', 'router']);
    expect(timeline[1]).toMatchObject({
      state: 'completed',
      duration: '30 ms',
    });
    expect(timeline[1].summary).toContain('structured debug');
    expect(timeline[1].summary).toContain('84% confidence');
    expect(timeline[1].detail).toContain('Structurizer completed with expected output hints.');
  });

  it('marks failed stage with error reason and preserves skipped summary', () => {
    const timeline = buildPipelineTimeline({
      pipeline: {
        version: 'v1',
        graph: 'simple-v1',
        route: 'simple',
        state: 'failed',
        currentStageId: undefined,
        stages: [
          {
            stageId: 'executor',
            label: 'Executor',
            state: 'failed',
            dependsOn: ['router'],
            startedAt: '2026-05-08T10:00:00.100Z',
            completedAt: '2026-05-08T10:00:01.300Z',
            output: {
              stageId: 'executor',
              status: 'failed',
              providerId: 'openai',
              modelId: 'gpt-4.1-mini',
              errorCode: 'rate_limit',
            },
            error: {
              code: 'provider.rate_limit',
              message: 'Too many requests.',
            },
          },
          {
            stageId: 'response',
            label: 'Response Assembly',
            state: 'skipped',
            dependsOn: ['executor'],
            startedAt: '2026-05-08T10:00:01.300Z',
            completedAt: '2026-05-08T10:00:01.300Z',
            skippedReason: 'Response skipped after executor failure.',
          },
        ],
        transitions: [],
      },
      trace: [
        {
          stage: 'executor.invoke',
          status: 'failed',
          timestamp: '2026-05-08T10:00:01.300Z',
          detail: 'Provider returned retryable rate limit.',
          metadata: {},
          error: {
            code: 'provider.rate_limit',
            message: 'Too many requests.',
          },
        },
      ],
    } satisfies Pick<TaskResponse, 'pipeline' | 'trace'>);

    expect(timeline[0]).toMatchObject({
      state: 'failed',
      duration: '1.2 s',
      error: 'provider.rate_limit: Too many requests.',
    });
    expect(timeline[1].summary).toBe('Response skipped after executor failure.');
    expect(timeline[1].detail).toContain('Response skipped after executor failure.');
  });

  it('shows verifier verdict and suggested action in timeline summary', () => {
    const timeline = buildPipelineTimeline({
      pipeline: {
        version: 'v1',
        graph: 'complex-v1',
        route: 'complex',
        state: 'completed',
        stages: [
          {
            stageId: 'verifier',
            label: 'Verifier',
            state: 'completed',
            dependsOn: ['executor'],
            startedAt: '2026-05-08T10:00:00.100Z',
            completedAt: '2026-05-08T10:00:00.120Z',
            output: {
              stageId: 'verifier',
              status: 'completed',
              detail: 'Verifier deferred until dedicated strategies land.',
              result: {
                verifierId: 'deferred-verifier',
                verifierKind: 'model',
                verdict: 'warning',
                summary: 'Verifier deferred.',
                reasons: ['No low-cost verifier ran for this response.'],
                suggestedAction: 'manual-confirm',
                findings: [],
              },
            },
          },
        ],
        transitions: [],
      },
      trace: [],
    } satisfies Pick<TaskResponse, 'pipeline' | 'trace'>);

    expect(timeline[0]?.summary).toBe('warning · action=manual-confirm · Verifier deferred until dedicated strategies land.');
  });

  it('shows merged composite verifier summary in timeline', () => {
    const timeline = buildPipelineTimeline({
      pipeline: {
        version: 'v1',
        graph: 'complex-v1',
        route: 'complex',
        state: 'completed',
        stages: [
          {
            stageId: 'verifier',
            label: 'Verifier',
            state: 'completed',
            dependsOn: ['executor'],
            startedAt: '2026-05-08T10:00:00.100Z',
            completedAt: '2026-05-08T10:00:00.120Z',
            output: {
              stageId: 'verifier',
              status: 'completed',
              detail: 'Combined verifier checks: model-consistency-v1=pass · rule-output-format-v1=fail',
              result: {
                verifierId: 'composite-verifier-v1',
                verifierKind: 'composite',
                verdict: 'fail',
                summary: 'Combined verifier checks: model-consistency-v1=pass · rule-output-format-v1=fail',
                reasons: ['rule-output-format-v1: Output did not satisfy explicit numbered list requirement.'],
                suggestedAction: 'retry',
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
            },
          },
        ],
        transitions: [],
      },
      trace: [],
    } satisfies Pick<TaskResponse, 'pipeline' | 'trace'>);

    expect(timeline[0]?.summary).toBe('fail · action=retry · Combined verifier checks: model-consistency-v1=pass · rule-output-format-v1=fail');
  });
});