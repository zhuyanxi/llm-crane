import { describe, expect, it } from 'vitest';
import type { PlannerResult, RouteDecision, StructurizerResult, TaskRequest } from '@llm-crane/schemas';
import { buildReasonerInput, parseReasonerOutput, reasonTask } from '../src/reasoner';

const baseTaskRequest: TaskRequest = {
  task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
  qualityBar: 'high',
  constraints: ['Keep public API stable', 'Avoid schema churn'],
  contexts: [
    {
      source: 'workspace',
      uri: '/workspace',
      content: 'workspace snapshot with many files and implementation details',
    },
    {
      source: 'file',
      uri: '/workspace/src/server.ts',
      languageId: 'typescript',
      content: 'export function start() { return wireEverything(); }',
    },
  ],
};

const baseStructurizerResult: StructurizerResult = {
  status: 'structured',
  confidence: 0.74,
  structuredTask: {
    originalTask: baseTaskRequest.task,
    taskType: 'analysis',
    goal: baseTaskRequest.task,
    target: {
      kind: 'workspace',
      value: '/workspace',
      uri: '/workspace',
    },
    qualityBar: 'high',
    constraints: baseTaskRequest.constraints,
    expectedOutput: ['Rank top risks, tradeoffs, and minimal remediation path for requested scope.'],
    openQuestions: ['Which module owns the retry policy?'],
    uncertaintyReasons: ['Cross-file ownership is unclear from the current snapshot.'],
    contextSummary: ['workspace / /workspace', 'file / typescript / /workspace/src/server.ts'],
  },
  warnings: [],
};

const complexRouteDecision: RouteDecision = {
  status: 'routed',
  route: 'complex',
  reason: 'Workspace-wide analysis needs broader reasoning.',
  confidence: 0.84,
  complexityScore: 9,
  scoreBreakdown: [
    {
      factor: 'task-type',
      score: 3,
      detail: 'Analysis task spans multiple modules.',
    },
  ],
  strategy: 'rules-v1',
};

const plannerResult: PlannerResult = {
  status: 'planned',
  summary: 'Execution plan for workspace analysis with 3 ordered steps.',
  steps: [
    {
      stepId: 'inspect-context',
      title: 'Inspect context and target',
      objective: 'Review attached contexts and constraints.',
      acceptance: 'Response reflects context and constraints.',
    },
    {
      stepId: 'survey-target',
      title: 'Survey target and risks',
      objective: 'Inspect target and identify main risks.',
      acceptance: 'Response names key files and risk areas.',
    },
    {
      stepId: 'deliver-answer',
      title: 'Deliver bounded final answer',
      objective: 'Return bounded answer with validation notes.',
      acceptance: 'Response requests explicit risks and next validation.',
    },
  ],
  decisionPoints: [
    {
      question: 'Which subsystem is the highest-risk dependency?',
      whyItMatters: 'Risk ranking drives final prioritization.',
      options: ['Retry policy', 'Schema boundary'],
      defaultChoice: 'Retry policy',
    },
    {
      question: 'Should the response prioritize architecture or operational risk first?',
      whyItMatters: 'Ordering changes the final remediation plan.',
      options: ['Architecture', 'Operations'],
      defaultChoice: 'Architecture',
    },
  ],
  openQuestions: ['Which module owns the retry policy?'],
  downstreamHints: {
    reasonerFocus: ['Compare top risks and rank by impact.'],
    verifierChecks: ['Confirm public API stays stable.'],
  },
  warnings: [],
};

describe('buildReasonerInput', () => {
  it('keeps simple-route input compressed and marks router early exit', () => {
    const input = buildReasonerInput(
      {
        ...baseTaskRequest,
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
      {
        status: 'structured',
        confidence: 0.9,
        structuredTask: {
          originalTask: 'Refactor current selection to reduce duplication without changing public API.',
          taskType: 'refactor',
          goal: 'Reduce duplication in the current selection.',
          target: {
            kind: 'selection',
            value: 'current selection',
          },
          qualityBar: 'fast',
          constraints: ['Keep public API stable'],
          expectedOutput: ['Return bounded refactor guidance or code-change summary tied to explicit constraints.'],
          openQuestions: [],
          uncertaintyReasons: [],
          contextSummary: ['selection / typescript / /workspace/src/auth.ts'],
        },
        warnings: [],
      },
      {
        status: 'routed',
        route: 'simple',
        reason: 'Selection-scoped refactor is bounded.',
        confidence: 0.9,
        complexityScore: 2,
        scoreBreakdown: [],
        strategy: 'rules-v1',
      },
    );

    expect(input.needReasoning).toBe(false);
    expect(input.decisionSource).toBe('router');
    expect(input.earlyExitReason).toContain('simple path');

    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('function loginUser()');
    expect(serialized).not.toContain('Refactor current selection to reduce duplication without changing public API.');
  });

  it('escalates complex workspace analysis from combined router and planner signals', () => {
    const input = buildReasonerInput(baseTaskRequest, baseStructurizerResult, complexRouteDecision, plannerResult);

    expect(input.needReasoning).toBe(true);
    expect(input.decisionSource).toBe('router+planner');
    expect(input.escalationReason).toContain('Router complexity score');
    expect(input.plannerFocus).toContain('Compare top risks and rank by impact.');
  });
});

describe('reasonTask', () => {
  it('returns summarized evidence when reasoning is required', () => {
    const input = buildReasonerInput(baseTaskRequest, baseStructurizerResult, complexRouteDecision, plannerResult);
    const result = reasonTask(input);

    expect(result.status).toBe('reasoned');
    expect(result.needReasoning).toBe(true);
    expect(result.summary).toContain('Escalate reasoning');
    expect(result.keyEvidence.length).toBeGreaterThan(0);
  });

  it('falls back when parsed reasoner output is invalid', () => {
    const input = buildReasonerInput(baseTaskRequest, baseStructurizerResult, complexRouteDecision, plannerResult);
    const result = parseReasonerOutput({ invalid: true }, input);

    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toContain('Reasoner output invalid');
  });
});