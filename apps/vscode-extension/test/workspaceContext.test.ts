import { describe, expect, it } from 'vitest';
import {
  applyContextBudgetPruning,
  createRegisteredTaskContext,
  createWorkspaceContextSourceRegistry,
  scoreContextRelevance,
} from '../src/workspaceContext';

describe('workspace context registry', () => {
  it('registers built-in file, selection, terminal, and user sources', () => {
    const registry = createWorkspaceContextSourceRegistry();

    expect(registry.get('file')?.supportsUri).toBe(true);
    expect(registry.get('selection')?.supportsLanguageId).toBe(true);
    expect(registry.get('terminal')?.supportsCommand).toBe(true);
    expect(registry.get('user')?.defaultPriority).toBe('supporting');
  });

  it('creates task context with unified source metadata', () => {
    const context = createRegisteredTaskContext({
      source: 'terminal',
      content: 'Error: token expired',
      command: 'pnpm test auth',
    });

    expect(context).toMatchObject({
      source: 'terminal',
      priority: 'supporting',
      sourceMetadata: {
        source: 'terminal',
        label: 'Terminal output',
        command: 'pnpm test auth',
      },
    });
  });
});

describe('workspace context relevance and pruning', () => {
  it('ranks terminal stack traces above unrelated files for debug tasks', () => {
    const contexts = [
      createRegisteredTaskContext({
        source: 'file',
        priority: 'primary',
        uri: '/workspace/src/theme.ts',
        languageId: 'typescript',
        content: 'export const palette = ["blue", "green"];',
      }),
      createRegisteredTaskContext({
        source: 'terminal',
        content: 'TypeError: Cannot read properties of undefined\n    at login (/workspace/src/auth.ts:12:7)',
        command: 'pnpm test auth',
      }),
    ];

    const ranked = scoreContextRelevance({
      task: 'Debug failing auth login TypeError in src/auth.ts',
      taskType: 'debug',
      contexts,
    });

    expect(ranked[0]?.source).toBe('terminal');
    expect(ranked[0]?.relevance?.rank).toBe(1);
    expect(ranked[0]?.relevance?.factors.map((factor) => factor.factor)).toContain('error-stack');
  });

  it('keeps locked user notes while pruning low relevance context to budget', () => {
    const ranked = scoreContextRelevance({
      task: 'Refactor auth token refresh while preserving tenant isolation',
      taskType: 'refactor',
      contexts: [
        createRegisteredTaskContext({
          source: 'user',
          content: 'Must preserve tenant isolation guarantee.',
          locked: true,
        }),
        createRegisteredTaskContext({
          source: 'file',
          uri: '/workspace/src/auth.ts',
          languageId: 'typescript',
          content: 'export function refreshToken(tenantId: string) { return tenantId; }',
        }),
        createRegisteredTaskContext({
          source: 'file',
          uri: '/workspace/src/irrelevant.ts',
          languageId: 'typescript',
          content: 'x'.repeat(240),
        }),
      ],
    });

    const pruned = applyContextBudgetPruning(ranked, {
      structurizer: 16,
      planner: 28,
      reasoner: 32,
    });

    expect(pruned.contexts.some((context) => context.source === 'user' && context.locked)).toBe(true);
    expect(pruned.contexts.some((context) => context.uri?.endsWith('irrelevant.ts'))).toBe(false);
    expect(pruned.stageSummaries).toHaveLength(3);
    expect(pruned.stageSummaries.every((summary) => summary.totalCount === 3)).toBe(true);
  });
});
