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
});