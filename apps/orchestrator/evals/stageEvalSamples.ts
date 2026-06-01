import type { TaskContext, TaskRequest } from '@llm-crane/schemas';

export type StageId = 'structurizer' | 'router' | 'planner' | 'verifier';

export type StageEvalSample = {
  id: string;
  stageId: StageId;
  task: string;
  qualityBar: 'fast' | 'balanced' | 'high';
  contexts: TaskContext[];
  constraints: string[];
  note: string;
  // Structurizer expectations
  expectedStatus?: 'structured' | 'fallback';
  expectedTaskType?: string;
  expectedTargetKind?: string;
  // Router expectations
  expectedRoute?: 'simple' | 'complex';
  minComplexityScore?: number;
  routerTolerance?: 'loose';
  // Planner expectations
  expectedPlannerStatus?: 'planned' | 'fallback';
  minPlanSteps?: number;
  // Verifier expectations
  verifierOutputText?: string;
  verifierProviderStatus?: 'completed' | 'failed';
  expectedVerdict?: string;
  expectedAction?: string;
  expectedFindingCode?: string;
};

export function sampleToTaskRequest(sample: StageEvalSample): TaskRequest {
  return {
    task: sample.task,
    qualityBar: sample.qualityBar,
    contexts: sample.contexts,
    constraints: sample.constraints,
  };
}

export const STRUCTURIZER_EVAL_SAMPLES: StageEvalSample[] = [
  {
    id: 'structurizer-refactor-selection',
    stageId: 'structurizer',
    task: 'Refactor current selection to reduce duplication without changing public API.',
    qualityBar: 'fast',
    contexts: [
      { source: 'selection', uri: '/workspace/src/auth.ts', languageId: 'typescript', content: 'function loginUser() { return doLogin(); }' },
    ],
    constraints: [],
    expectedStatus: 'structured',
    expectedTaskType: 'refactor',
    expectedTargetKind: 'selection',
    note: 'Selection refactor with fast quality bar.',
  },
  {
    id: 'structurizer-debug-file',
    stageId: 'structurizer',
    task: 'Debug failing login flow in src/auth.ts. Error says token expires immediately.',
    qualityBar: 'balanced',
    contexts: [
      { source: 'file', uri: '/workspace/src/auth.ts', languageId: 'typescript', content: 'export async function login() { throw new Error(); }' },
    ],
    constraints: [],
    expectedStatus: 'structured',
    expectedTaskType: 'debug',
    expectedTargetKind: 'file',
    note: 'Debug task with file target.',
  },
  {
    id: 'structurizer-analysis-workspace',
    stageId: 'structurizer',
    task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
    qualityBar: 'high',
    contexts: [
      { source: 'workspace', uri: '/workspace', content: 'workspace snapshot' },
      { source: 'file', uri: '/workspace/src/server.ts', languageId: 'typescript', content: 'export function start() {}' },
    ],
    constraints: ['Keep public API stable', 'Avoid schema churn'],
    expectedStatus: 'structured',
    expectedTaskType: 'analysis',
    expectedTargetKind: 'workspace',
    note: 'Workspace analysis with constraints.',
  },
  {
    id: 'structurizer-vague-fallback',
    stageId: 'structurizer',
    task: 'Fix it.',
    qualityBar: 'balanced',
    contexts: [],
    constraints: [],
    expectedStatus: 'fallback',
    note: 'Vague task should trigger structurizer fallback.',
  },
  {
    id: 'structurizer-implementation-file',
    stageId: 'structurizer',
    task: 'Implement addCompanyLogo function in src/theme.ts.',
    qualityBar: 'fast',
    contexts: [
      { source: 'file', uri: '/workspace/src/theme.ts', languageId: 'typescript', content: 'export const palette = ["blue"];' },
    ],
    constraints: [],
    expectedStatus: 'structured',
    expectedTaskType: 'implementation',
    expectedTargetKind: 'file',
    note: 'Implementation with file target.',
  },
];

export const ROUTER_EVAL_SAMPLES: StageEvalSample[] = [
  {
    id: 'router-simple-narrow',
    stageId: 'router',
    task: 'Refactor current selection to reduce duplication without changing public API.',
    qualityBar: 'fast',
    contexts: [
      { source: 'selection', uri: '/workspace/src/auth.ts', languageId: 'typescript', content: 'function loginUser() { return doLogin(); }' },
    ],
    constraints: [],
    expectedRoute: 'simple',
    minComplexityScore: 0,
    note: 'Narrow fast refactor stays simple.',
  },
  {
    id: 'router-complex-workspace-high',
    stageId: 'router',
    task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
    qualityBar: 'high',
    contexts: [
      { source: 'workspace', uri: '/workspace', content: 'workspace snapshot' },
      { source: 'file', uri: '/workspace/src/server.ts', languageId: 'typescript', content: 'export function start() {}' },
    ],
    constraints: ['Keep public API stable', 'Avoid schema churn', 'Must not break existing deployments'],
    expectedRoute: 'complex',
    minComplexityScore: 4,
    note: 'Workspace high-quality analysis routes complex.',
  },
  {
    id: 'router-boundary-moderate',
    stageId: 'router',
    task: 'Debug failing token refresh TypeError in src/auth.ts.',
    qualityBar: 'balanced',
    contexts: [
      { source: 'file', uri: '/workspace/src/auth.ts', languageId: 'typescript', content: 'export async function refreshToken(tenantId: string) { throw new TypeError("expired"); }' },
    ],
    constraints: ['Keep tenant isolation intact.'],
    expectedRoute: 'complex',
    minComplexityScore: 2,
    routerTolerance: 'loose',
    note: 'Debug with constraint at boundary — may route simple with single context.',
  },
  {
    id: 'router-fast-test-simple',
    stageId: 'router',
    task: 'Write unit test for calculateDiscount function in src/pricing.ts.',
    qualityBar: 'fast',
    contexts: [
      { source: 'selection', uri: '/workspace/src/pricing.ts', languageId: 'typescript', content: 'function calculateDiscount(price: number, tier: string) { return price * 0.9; }' },
    ],
    constraints: [],
    expectedRoute: 'simple',
    minComplexityScore: 0,
    note: 'Fast unit test task stays simple.',
  },
];

export const PLANNER_EVAL_SAMPLES: StageEvalSample[] = [
  {
    id: 'planner-complex-analysis',
    stageId: 'planner',
    task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
    qualityBar: 'high',
    contexts: [
      { source: 'workspace', uri: '/workspace', content: 'workspace snapshot' },
      { source: 'file', uri: '/workspace/src/server.ts', languageId: 'typescript', content: 'export function start() {}' },
    ],
    constraints: ['Keep public API stable', 'Avoid schema churn'],
    expectedPlannerStatus: 'planned',
    minPlanSteps: 3,
    note: 'Complex analysis should produce plan with 3+ steps.',
  },
  {
    id: 'planner-fallback-on-bad-input',
    stageId: 'planner',
    task: 'Analyze this.',
    qualityBar: 'balanced',
    contexts: [],
    constraints: [],
    expectedPlannerStatus: 'fallback',
    minPlanSteps: 1,
    note: 'Fallback on vague input.',
  },
];

export const VERIFIER_EVAL_SAMPLES: StageEvalSample[] = [
  {
    id: 'verifier-pass-clean-output',
    stageId: 'verifier',
    task: 'Analyze workspace risk.',
    qualityBar: 'high',
    contexts: [
      { source: 'workspace', uri: '/workspace', content: 'workspace snapshot' },
    ],
    constraints: ['Return numbered list of risks with actions.'],
    verifierOutputText: '1. Auth module risk: token expiry window too wide.\n2. Session risk: cross-tenant session leak.\n3. Config risk: env loading blocks startup.',
    verifierProviderStatus: 'completed',
    expectedVerdict: 'pass',
    expectedAction: 'proceed',
    note: 'Output satisfies numbered list constraint.',
  },
  {
    id: 'verifier-fail-missing-format',
    stageId: 'verifier',
    task: 'Analyze workspace risk.',
    qualityBar: 'high',
    contexts: [
      { source: 'workspace', uri: '/workspace', content: 'workspace snapshot' },
    ],
    constraints: ['Return numbered list of risks.'],
    verifierOutputText: 'Auth module has risk. Session has risk. Config has risk.',
    verifierProviderStatus: 'completed',
    expectedVerdict: 'fail',
    expectedAction: 'retry',
    expectedFindingCode: 'format_numbered_list_missing',
    note: 'Output missing numbered list format fails rule verifier.',
  },
  {
    id: 'verifier-no-rule-match',
    stageId: 'verifier',
    task: 'Analyze workspace risk.',
    qualityBar: 'high',
    contexts: [
      { source: 'workspace', uri: '/workspace', content: 'workspace snapshot' },
    ],
    constraints: ['Return ranked risks'],
    verifierOutputText: 'output text without numbering.',
    verifierProviderStatus: 'completed',
    expectedVerdict: 'warning',
    expectedAction: 'manual-confirm',
    note: 'No list-format constraint detected; empty verifier results default to warning with manual-confirm.',
  },
];

export const STAGE_EVAL_SAMPLES: StageEvalSample[] = [
  ...STRUCTURIZER_EVAL_SAMPLES,
  ...ROUTER_EVAL_SAMPLES,
  ...PLANNER_EVAL_SAMPLES,
  ...VERIFIER_EVAL_SAMPLES,
];
