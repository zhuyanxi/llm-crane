import { describe, expect, it } from 'vitest';
import type { TaskRequest } from '@llm-crane/schemas';
import { buildStructurizerPrompt, parseStructurizerOutput, structurizeTaskRequest } from '../src/structurizer';

function makeTaskRequest(task: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    task,
    qualityBar: 'balanced',
    contexts: [],
    constraints: [],
    ...overrides,
  };
}

describe('structurizeTaskRequest', () => {
  it('structures refactor task from current selection', () => {
    const result = structurizeTaskRequest(
      makeTaskRequest('Refactor current selection to reduce duplication without changing public API.', {
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      }),
    );

    expect(result.status).toBe('structured');
    expect(result.structuredTask.taskType).toBe('refactor');
    expect(result.structuredTask.target.kind).toBe('selection');
    expect(result.structuredTask.constraints).toContain('Avoid changing public API');
  });

  it('structures debug task for explicit file target', () => {
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

    expect(result.status).toBe('structured');
    expect(result.structuredTask.taskType).toBe('debug');
    expect(result.structuredTask.target.kind).toBe('file');
    expect(result.structuredTask.openQuestions).toHaveLength(0);
  });

  it('keeps leading analysis verb over later fix keyword', () => {
    const result = structurizeTaskRequest(
      makeTaskRequest('Analyze whole workspace for architecture risk and propose robust fixes.', {
        qualityBar: 'high',
        contexts: [
          {
            source: 'workspace',
            uri: '/workspace',
            content: 'workspace snapshot',
          },
        ],
        constraints: ['Keep public API stable'],
      }),
    );

    expect(result.status).toBe('structured');
    expect(result.structuredTask.taskType).toBe('analysis');
    expect(result.structuredTask.openQuestions).toHaveLength(0);
  });

  it('marks fallback when analysis task misses concrete target', () => {
    const result = structurizeTaskRequest(makeTaskRequest('Analyze this.'));

    expect(result.status).toBe('fallback');
    expect(result.structuredTask.taskType).toBe('analysis');
    expect(result.structuredTask.openQuestions).toContain('What code artifact should this task apply to?');
    expect(result.fallbackReason).toBeTruthy();
  });
});

describe('parseStructurizerOutput', () => {
  it('strips extra fields from otherwise valid structurizer payload', () => {
    const taskRequest = makeTaskRequest('Review current file for bug risk.', {
      contexts: [
        {
          source: 'file',
          uri: '/workspace/src/app.ts',
          languageId: 'typescript',
          content: 'const value = 1;',
        },
      ],
    });

    const parsed = parseStructurizerOutput(
      {
        status: 'structured',
        structuredTask: {
          originalTask: taskRequest.task,
          taskType: 'analysis',
          goal: taskRequest.task,
          target: {
            kind: 'file',
            value: '/workspace/src/app.ts',
            uri: '/workspace/src/app.ts',
            extraField: 'drop-me',
          },
          qualityBar: 'balanced',
          constraints: [],
          openQuestions: [],
          uncertaintyReasons: [],
          contextSummary: ['file / typescript / /workspace/src/app.ts'],
          extraField: 'drop-me',
        },
        warnings: [],
        extraField: 'drop-me',
      },
      taskRequest,
    );

    expect(parsed.status).toBe('structured');
    expect(parsed).not.toHaveProperty('extraField');
    expect(parsed.structuredTask).not.toHaveProperty('extraField');
    expect(parsed.structuredTask.target).not.toHaveProperty('extraField');
  });

  it('falls back when structurizer payload misses required fields', () => {
    const taskRequest = makeTaskRequest('Refactor helper.');
    const parsed = parseStructurizerOutput(
      {
        status: 'structured',
        structuredTask: {
          taskType: 'refactor',
        },
      },
      taskRequest,
    );

    expect(parsed.status).toBe('fallback');
    expect(parsed.fallbackReason).toContain('Structurizer output invalid');
  });
});

describe('buildStructurizerPrompt', () => {
  it('includes task text and context count in prompt template', () => {
    const prompt = buildStructurizerPrompt(
      makeTaskRequest('Analyze current file for architecture issues.', {
        contexts: [
          {
            source: 'file',
            uri: '/workspace/src/server.ts',
            languageId: 'typescript',
            content: 'export function start() {}',
          },
        ],
      }),
    );

    expect(prompt).toContain('Analyze current file for architecture issues.');
    expect(prompt).toContain('Context count: 1');
  });
});