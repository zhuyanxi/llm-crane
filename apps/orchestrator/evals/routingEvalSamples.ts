import type { TaskContext, TaskRequest } from '@llm-crane/schemas';

export type RoutingEvalSample = {
  id: string;
  task: string;
  qualityBar: 'fast' | 'balanced' | 'high';
  taskType: string;
  contexts: TaskContext[];
  constraints: string[];
  expectedRoute: 'simple' | 'complex';
  tolerance?: 'loose';
  complexityScoreMin?: number;
  complexityScoreMax?: number;
  costLabel: 'low' | 'medium' | 'high';
  note: string;
};

export function sampleToTaskRequest(sample: RoutingEvalSample): TaskRequest {
  return {
    task: sample.task,
    qualityBar: sample.qualityBar,
    contexts: sample.contexts,
    constraints: sample.constraints,
  };
}

export const ROUTING_EVAL_SAMPLES: RoutingEvalSample[] = [
  {
    id: 'refactor-narrow-selection',
    task: 'Refactor current selection to reduce duplication without changing public API.',
    qualityBar: 'fast',
    taskType: 'refactor',
    contexts: [
      {
        source: 'selection',
        uri: '/workspace/src/auth.ts',
        languageId: 'typescript',
        content: 'function loginUser() { return doLogin(); }',
      },
    ],
    constraints: [],
    expectedRoute: 'simple',
    complexityScoreMin: 0,
    complexityScoreMax: 3,
    costLabel: 'low',
    note: 'Narrow selection refactor with fast quality bar should stay simple.',
  },
  {
    id: 'debug-file-error-stack',
    task: 'Debug failing token refresh TypeError at login in src/auth.ts.',
    qualityBar: 'high',
    taskType: 'debug',
    contexts: [
      {
        source: 'file',
        uri: '/workspace/src/auth.ts',
        languageId: 'typescript',
        content: 'export async function refreshToken(tenantId: string) { throw new TypeError("expired"); }',
      },
      {
        source: 'file',
        uri: '/workspace/src/session.ts',
        languageId: 'typescript',
        content: 'export class SessionManager { private tokens = new Map(); }',
      },
    ],
    constraints: ['Keep tenant isolation intact.', 'Token rotation must not break existing sessions'],
    expectedRoute: 'complex',
    complexityScoreMin: 3,
    complexityScoreMax: 10,
    costLabel: 'medium',
    note: 'Debug task with high quality bar, multiple contexts, and constraints should route complex.',
  },
  {
    id: 'architecture-workspace-high-quality',
    task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
    qualityBar: 'high',
    taskType: 'analysis',
    contexts: [
      {
        source: 'workspace',
        uri: '/workspace',
        content: 'workspace snapshot with 45 modules',
      },
      {
        source: 'file',
        uri: '/workspace/src/server.ts',
        languageId: 'typescript',
        content: 'export function start() {}',
      },
    ],
    constraints: ['Keep public API stable', 'Avoid schema churn', 'Must not break existing deployments'],
    expectedRoute: 'complex',
    complexityScoreMin: 4,
    complexityScoreMax: 14,
    costLabel: 'high',
    note: 'Workspace-target architecture analysis with many constraints should route complex.',
  },
  {
    id: 'implementation-fast-single-file',
    task: 'Implement addCompanyLogo function in src/theme.ts returning hard-coded SVG string.',
    qualityBar: 'fast',
    taskType: 'implementation',
    contexts: [
      {
        source: 'file',
        uri: '/workspace/src/theme.ts',
        languageId: 'typescript',
        content: 'export const palette = ["blue"];',
      },
    ],
    constraints: [],
    expectedRoute: 'simple',
    complexityScoreMin: 0,
    complexityScoreMax: 3,
    costLabel: 'low',
    note: 'Small implementation with no constraints stays simple.',
  },
  {
    id: 'debug-workspace-open-questions',
    task: 'Debug intermittent CI timeout across multiple packages.',
    qualityBar: 'high',
    taskType: 'debug',
    contexts: [
      {
        source: 'workspace',
        uri: '/workspace',
        content: 'multi-package monorepo with CI configs',
      },
    ],
    constraints: ['Must not slow CI pipeline', 'Fix should work across Node 18-22'],
    expectedRoute: 'complex',
    complexityScoreMin: 5,
    complexityScoreMax: 14,
    costLabel: 'high',
    note: 'Workspace debug with high quality bar and multiple constraints should route complex.',
  },
  {
    id: 'refactor-safe-with-constraints',
    task: 'Refactor logger module to support structured logging while keeping existing callers unchanged.',
    qualityBar: 'balanced',
    taskType: 'refactor',
    contexts: [
      {
        source: 'file',
        uri: '/workspace/src/logger.ts',
        languageId: 'typescript',
        content: 'export function log(level: string, msg: string) { console.log(level, msg); }',
      },
    ],
    constraints: ['Keep existing log() signature', 'No breaking change to 34 call sites'],
    expectedRoute: 'complex',
    complexityScoreMin: 3,
    complexityScoreMax: 8,
    costLabel: 'medium',
    note: 'Refactor with multiple constraints and many call-sites should route complex.',
  },
  {
    id: 'test-simple-unit',
    task: 'Write unit test for calculateDiscount function in src/pricing.ts.',
    qualityBar: 'fast',
    taskType: 'test',
    contexts: [
      {
        source: 'selection',
        uri: '/workspace/src/pricing.ts',
        languageId: 'typescript',
        content: 'function calculateDiscount(price: number, tier: string) { return price * 0.9; }',
      },
    ],
    constraints: [],
    expectedRoute: 'simple',
    complexityScoreMin: 0,
    complexityScoreMax: 3,
    costLabel: 'low',
    note: 'Small test task with selection target stays simple.',
  },
  {
    id: 'test-integration-suite',
    task: 'Write integration test suite covering end-to-end checkout flow with payment gateway mock.',
    qualityBar: 'balanced',
    taskType: 'test',
    contexts: [
      {
        source: 'file',
        uri: '/workspace/src/checkout.ts',
        languageId: 'typescript',
        content: 'export async function checkout(cart: Cart, payment: PaymentMethod) { /* multi-step flow */ }',
      },
    ],
    constraints: ['Must mock payment gateway', 'Cover happy path and 3 error paths'],
    expectedRoute: 'complex',
    tolerance: 'loose',
    complexityScoreMin: 2,
    complexityScoreMax: 10,
    costLabel: 'medium',
    note: 'Integration test with broader scope may or may not route complex depending on structurizer.',
  },
  {
    id: 'analysis-selection-symbol',
    task: 'Review calculateDiscount.',
    qualityBar: 'fast',
    taskType: 'analysis',
    contexts: [
      {
        source: 'selection',
        uri: '/workspace/src/pricing.ts',
        languageId: 'typescript',
        content: 'function calculateDiscount(price: number, tier: string) { return price * 0.9; }',
      },
    ],
    constraints: [],
    expectedRoute: 'simple',
    tolerance: 'loose',
    complexityScoreMin: 0,
    complexityScoreMax: 4,
    costLabel: 'low',
    note: 'Minimal review task with fast quality bar. Structurizer may fall back on very short analysis tasks, routing complex acceptably.',
  },
  {
    id: 'implementation-large-feature',
    task: 'Implement multi-tenant session manager with tenant isolation, token rotation, and audit logging.',
    qualityBar: 'high',
    taskType: 'implementation',
    contexts: [
      {
        source: 'workspace',
        uri: '/workspace',
        content: 'monorepo with auth, session, audit packages',
      },
    ],
    constraints: [
      'Must isolate tenant sessions completely',
      'Token rotation must be atomic',
      'Audit log must be append-only',
      'No shared state across tenants',
    ],
    expectedRoute: 'complex',
    complexityScoreMin: 6,
    complexityScoreMax: 16,
    costLabel: 'high',
    note: 'Large implementation with workspace target, high quality, many constraints should route complex.',
  },
];

export type RoutingEvalResult = {
  sampleId: string;
  expectedRoute: string;
  actualRoute: string;
  passed: boolean;
  strategy: string;
  complexityScore: number;
  riskScore: number;
  budgetPressureScore: number;
  compositeScore: number;
  confidence: number;
  costLabel: string;
};

export type RoutingEvalReport = {
  results: RoutingEvalResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    tolerantPassed: number;
    simpleRoutes: number;
    complexRoutes: number;
    costSavingsEstimate: string;
  };
};
