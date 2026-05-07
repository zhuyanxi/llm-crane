import { describe, expect, it } from 'vitest';
import type { TaskRequest } from '@llm-crane/schemas';
import { buildPlannerPrompt, createFallbackPlannerResult, parsePlannerOutput, planTask } from '../src/planner';
import { createSafeFallbackRouteDecision, routeTask } from '../src/router';
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

describe('planTask', () => {
  it('builds explicit plan for complex task', () => {
    const taskRequest = makeTaskRequest('Analyze whole workspace for architecture risk and propose robust fixes.', {
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
    });

    const structurizerResult = structurizeTaskRequest(taskRequest);
    const routeDecision = routeTask(structurizerResult);
    const plannerResult = planTask(taskRequest, structurizerResult, routeDecision);

    expect(routeDecision.route).toBe('complex');
    expect(plannerResult.status).toBe('planned');
    expect(plannerResult.steps.length).toBeGreaterThanOrEqual(3);
    expect(plannerResult.decisionPoints.length).toBeGreaterThan(0);
    expect(plannerResult.downstreamHints.verifierChecks.some((entry) => entry.includes('Keep public API stable'))).toBe(true);
  });

  it('falls back conservatively when planner payload is invalid', () => {
    const taskRequest = makeTaskRequest('Analyze this.');
    const structurizerResult = structurizeTaskRequest(taskRequest);
    const routeDecision = createSafeFallbackRouteDecision('planner parse fallback test');

    const plannerResult = parsePlannerOutput(
      {
        status: 'planned',
        summary: 'bad payload',
      },
      taskRequest,
      structurizerResult,
      routeDecision,
    );

    expect(plannerResult.status).toBe('fallback');
    expect(plannerResult.fallbackReason).toContain('Planner output invalid');
    expect(plannerResult.steps.length).toBeGreaterThan(0);
  });
});

describe('buildPlannerPrompt', () => {
  it('includes task, structured task, and route decision', () => {
    const taskRequest = makeTaskRequest('Analyze current file for architecture issues.', {
      contexts: [
        {
          source: 'file',
          uri: '/workspace/src/server.ts',
          languageId: 'typescript',
          content: 'export function start() {}',
        },
      ],
    });
    const structurizerResult = structurizeTaskRequest(taskRequest);
    const routeDecision = routeTask(structurizerResult);

    const prompt = buildPlannerPrompt(taskRequest, structurizerResult, routeDecision);

    expect(prompt).toContain('Analyze current file for architecture issues.');
    expect(prompt).toContain('Structured task:');
    expect(prompt).toContain('Route decision:');
  });
});

describe('createFallbackPlannerResult', () => {
  it('builds conservative plan when planner stage crashes', () => {
    const taskRequest = makeTaskRequest('Analyze current file for architecture issues.');
    const structurizerResult = structurizeTaskRequest(taskRequest);
    const routeDecision = createSafeFallbackRouteDecision('planner crash');

    const plannerResult = createFallbackPlannerResult(taskRequest, structurizerResult, routeDecision, 'planner crash');

    expect(plannerResult.status).toBe('fallback');
    expect(plannerResult.fallbackReason).toBe('planner crash');
    expect(plannerResult.steps[0]?.stepId).toBe('inspect-context');
  });
});