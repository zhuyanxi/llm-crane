import type { ContextBudgetStage, TaskContext } from '@llm-crane/schemas';
import { createRegisteredTaskContext } from '../src/workspaceContext';

export type ContextPruningEvalSample = {
  id: string;
  task: string;
  taskType: string;
  templateId?: string;
  budget: Record<ContextBudgetStage, number>;
  contexts: Array<Parameters<typeof createRegisteredTaskContext>[0]>;
  mustRetain: string[];
  expectedDroppedUri?: string;
};

export const CONTEXT_PRUNING_EVAL_SAMPLES: ContextPruningEvalSample[] = [
  {
    id: 'refactor-auth-token-refresh',
    task: 'Refactor src/auth.ts token refresh flow and preserve tenant isolation.',
    taskType: 'refactor',
    templateId: 'refactor',
    budget: { structurizer: 28, planner: 48, reasoner: 64 },
    contexts: [
      {
        source: 'selection',
        priority: 'primary',
        uri: '/workspace/src/auth.ts',
        languageId: 'typescript',
        content: 'const refreshed = await refreshToken(tenantId, session.userId);',
        locked: true,
      },
      {
        source: 'file',
        priority: 'supporting',
        uri: '/workspace/src/auth.ts',
        languageId: 'typescript',
        content: 'export async function refreshToken(tenantId: string, userId: string) { return tokenStore.rotate(tenantId, userId); }',
      },
      {
        source: 'file',
        priority: 'supporting',
        uri: '/workspace/src/colors.ts',
        languageId: 'typescript',
        content: 'export const colors = ' + 'blue,'.repeat(120),
      },
    ],
    mustRetain: ['refreshToken', 'tenantId'],
    expectedDroppedUri: '/workspace/src/colors.ts',
  },
  {
    id: 'debug-email-send-typeerror',
    task: 'Debug failing email send TypeError from terminal output and identify smallest fix.',
    taskType: 'debug',
    templateId: 'debug',
    budget: { structurizer: 32, planner: 56, reasoner: 80 },
    contexts: [
      {
        source: 'terminal',
        priority: 'primary',
        content: 'TypeError: Cannot read properties of undefined (reading send)\n    at sendReceipt (/workspace/src/email.ts:42:19)\n    at checkout (/workspace/src/checkout.ts:88:5)',
        command: 'pnpm test checkout',
        locked: true,
      },
      {
        source: 'file',
        priority: 'supporting',
        uri: '/workspace/src/email.ts',
        languageId: 'typescript',
        content: 'export function sendReceipt(client?: MailClient) { return client.send(); }',
      },
      {
        source: 'file',
        priority: 'supporting',
        uri: '/workspace/src/marketing.ts',
        languageId: 'typescript',
        content: 'export const campaignCopy = ' + 'sale '.repeat(160),
      },
    ],
    mustRetain: ['Cannot read properties of undefined', 'sendReceipt'],
    expectedDroppedUri: '/workspace/src/marketing.ts',
  },
  {
    id: 'architecture-routing-tenant-isolation',
    task: 'Architecture analysis for routing changes; rank risks and preserve tenant isolation.',
    taskType: 'analysis',
    templateId: 'architecture-analysis',
    budget: { structurizer: 36, planner: 64, reasoner: 88 },
    contexts: [
      {
        source: 'user',
        priority: 'primary',
        content: 'Must retain tenant isolation and avoid shared cache keys across organizations.',
        locked: true,
      },
      {
        source: 'workspace',
        priority: 'supporting',
        uri: '/workspace/packages/router',
        content: 'Router chooses organization scoped model policy; cache key includes orgId and modelId.',
      },
      {
        source: 'file',
        priority: 'supporting',
        uri: '/workspace/docs/old-roadmap.md',
        languageId: 'markdown',
        content: 'Archived roadmap ' + 'legacy '.repeat(180),
      },
    ],
    mustRetain: ['tenant isolation', 'cache key includes orgId'],
    expectedDroppedUri: '/workspace/docs/old-roadmap.md',
  },
];

export function buildContextPruningEvalContexts(sample: ContextPruningEvalSample): TaskContext[] {
  return sample.contexts.map((context, index) => createRegisteredTaskContext(context, index));
}
