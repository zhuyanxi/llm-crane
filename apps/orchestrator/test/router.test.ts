import { describe, expect, it } from 'vitest';
import type { TaskRequest } from '@llm-crane/schemas';
import { buildRouterScoreInput, parseRouteDecision, routeTask } from '../src/router';
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

describe('routeTask', () => {
  it('routes narrow refactor task to simple path', () => {
    const decision = routeTask(
      structurizeTaskRequest(
        makeTaskRequest('Refactor current selection to reduce duplication without changing public API.', {
          qualityBar: 'fast',
          contexts: [
            {
              source: 'selection',
              uri: '/workspace/src/auth.ts',
              languageId: 'typescript',
              content: 'function loginUser() { return doLogin(); }',
            },
          ],
        }),
      ),
    );

    expect(decision.status).toBe('routed');
    expect(decision.route).toBe('simple');
    expect(decision.reason).toContain('scope');
  });

  it('routes broad high-quality analysis task to complex path', () => {
    const decision = routeTask(
      structurizeTaskRequest(
        makeTaskRequest('Analyze whole workspace for architecture risk and propose robust fixes.', {
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
        }),
      ),
    );

    expect(decision.status).toBe('routed');
    expect(decision.route).toBe('complex');
    expect(decision.complexityScore).toBeGreaterThanOrEqual(4);
  });

  it('defaults to safe fallback path when route payload is invalid', () => {
    const decision = parseRouteDecision({ route: 'simple' });

    expect(decision.status).toBe('fallback');
    expect(decision.route).toBe('complex');
    expect(decision.fallbackReason).toContain('Router output invalid');
  });
});

describe('buildRouterScoreInput', () => {
  it('summarizes structured-task fields for future scorer hook', () => {
    const result = structurizeTaskRequest(
      makeTaskRequest('Debug failing login flow in src/auth.ts. Error says token expires immediately.', {
        contexts: [
          {
            source: 'file',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'export async function login() { throw new Error(); }',
          },
        ],
      }),
    );

    const summary = buildRouterScoreInput(result);

    expect(summary).toContain('taskType=debug');
    expect(summary).toContain('target=file');
  });
});