import { describe, expect, it } from 'vitest';
import { planTaskContexts, resolveContextStrategy } from '../src/taskContextPlan';

const baseSnapshot = {
  uri: '/workspace/src/auth.ts',
  languageId: 'typescript',
  selectionContent: 'const token = refresh();',
  fileContent: 'export function login() {\n  const token = refresh();\n  return token;\n}',
};

describe('planTaskContexts', () => {
  it('uses selection as primary and file as supporting when selection-first template requests supporting context', () => {
    const result = planTaskContexts(
      baseSnapshot,
      resolveContextStrategy('template-default', {
        mode: 'selection-first',
        includeSupportingContext: true,
        maxChars: 200,
      }),
    );

    expect(result.blockingError).toBeUndefined();
    expect(result.contexts).toHaveLength(2);
    expect(result.contexts[0]).toMatchObject({ source: 'selection', priority: 'primary', truncated: false });
    expect(result.contexts[1]).toMatchObject({ source: 'file', priority: 'supporting', truncated: false });
  });

  it('returns no contexts for manual-only mode', () => {
    const result = planTaskContexts(
      baseSnapshot,
      resolveContextStrategy('manual-only', {
        mode: 'selection-first',
        includeSupportingContext: true,
        maxChars: 200,
      }),
    );

    expect(result.contexts).toEqual([]);
    expect(result.warnings).toContain('Manual-only mode selected. No editor context will be attached.');
  });

  it('truncates oversized file context and emits warning', () => {
    const result = planTaskContexts(
      {
        ...baseSnapshot,
        selectionContent: '',
        fileContent: 'x'.repeat(320),
      },
      resolveContextStrategy('file-first', {
        mode: 'selection-first',
        includeSupportingContext: false,
        maxChars: 120,
      }),
    );

    expect(result.blockingError).toBeUndefined();
    expect(result.contexts[0]).toMatchObject({ source: 'file', priority: 'primary', truncated: true, originalLength: 320 });
    expect(result.warnings[0]).toContain('truncated');
  });

  it('attaches terminal output and locked user notes in manual-only mode', () => {
    const result = planTaskContexts(
      baseSnapshot,
      resolveContextStrategy('manual-only', {
        mode: 'selection-first',
        includeSupportingContext: false,
        maxChars: 200,
      }),
      {
        task: 'Debug failing auth test',
        taskType: 'debug',
        supplementalSources: {
          terminalOutput: 'Error: token expired\n    at login (/workspace/src/auth.ts:4:2)',
          userNotes: 'Must preserve refresh token contract.',
        },
      },
    );

    expect(result.blockingError).toBeUndefined();
    expect(result.contexts.map((context) => context.source)).toEqual(['user', 'terminal']);
    expect(result.contexts[0]).toMatchObject({ source: 'user', locked: true });
    expect(result.contexts[1]?.sourceMetadata).toMatchObject({ source: 'terminal', label: 'Terminal output' });
  });

  it('locks primary context and reports pruning summaries', () => {
    const result = planTaskContexts(
      baseSnapshot,
      resolveContextStrategy('selection-first', {
        mode: 'selection-first',
        includeSupportingContext: true,
        maxChars: 200,
      }),
      {
        task: 'Refactor auth token refresh',
        taskType: 'refactor',
        lockPrimaryContext: true,
      },
    );

    expect(result.contexts[0]).toMatchObject({ source: 'selection', locked: true });
    expect(result.contexts[0]?.relevance?.rank).toBe(1);
    expect(result.pruningSummary?.map((summary) => summary.stage)).toEqual(['structurizer', 'planner', 'reasoner']);
  });
});