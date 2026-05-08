import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'deepseek', 'gemini', 'ollama']);
export const TransportSchema = z.enum(['stdio', 'ipc']);
export const QualityBarSchema = z.enum(['fast', 'balanced', 'high']);
export const CacheModeSchema = z.enum(['default', 'bypass']);
export const ProviderDeploymentModeSchema = z.enum(['hosted', 'local']);
export const ProviderApiFamilySchema = z.enum(['openai-compatible', 'anthropic', 'gemini', 'ollama']);
export const ProviderAuthModeSchema = z.enum(['none', 'bearer', 'header', 'query']);

export const ContextSourceSchema = z.enum(['manual', 'selection', 'file', 'workspace']);
export const ContextPrioritySchema = z.enum(['primary', 'supporting']);

export const TaskContextSchema = z.object({
  source: ContextSourceSchema,
  priority: ContextPrioritySchema.default('primary'),
  uri: z.string().optional(),
  languageId: z.string().optional(),
  content: z.string().min(1),
  truncated: z.boolean().default(false),
  originalLength: z.number().int().positive().optional(),
});

export const ProviderSelectionSchema = z.object({
  providerId: ProviderIdSchema,
  runtimeId: z.string().min(1).optional(),
  deploymentMode: ProviderDeploymentModeSchema.optional(),
  apiFamily: ProviderApiFamilySchema.optional(),
  modelId: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

export const ProviderRuntimeProfileSchema = z
  .object({
    runtimeId: z.string().min(1),
    providerId: ProviderIdSchema,
    deploymentMode: ProviderDeploymentModeSchema,
    apiFamily: ProviderApiFamilySchema,
    baseUrl: z.string().url(),
    models: z.array(z.string().min(1)).min(1),
    authMode: ProviderAuthModeSchema.default('none'),
    authToken: z.string().min(1).optional(),
    authHeaderName: z.string().min(1).optional(),
    authQueryParam: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().positive().optional(),
  })
  .superRefine((profile, context) => {
    if ((profile.authMode === 'bearer' || profile.authMode === 'header' || profile.authMode === 'query') && !profile.authToken) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `authToken is required when authMode=${profile.authMode}`,
        path: ['authToken'],
      });
    }

    if (profile.authMode === 'header' && !profile.authHeaderName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authHeaderName is required when authMode=header',
        path: ['authHeaderName'],
      });
    }

    if (profile.authMode === 'query' && !profile.authQueryParam) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authQueryParam is required when authMode=query',
        path: ['authQueryParam'],
      });
    }
  });

export const ProviderErrorCodeSchema = z.enum([
  'auth',
  'rate_limit',
  'timeout',
  'invalid_request',
  'network',
  'unsupported_model',
  'provider_not_configured',
  'upstream',
  'unknown',
]);

export const ProviderErrorSchema = z.object({
  providerId: ProviderIdSchema,
  code: ProviderErrorCodeSchema,
  message: z.string().min(1),
  retriable: z.boolean(),
  statusCode: z.number().int().positive().optional(),
});

export const ProviderUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

export const CacheStatusSchema = z.enum(['hit', 'miss', 'bypassed']);

export const DiagnosticCategorySchema = z.enum(['configuration', 'provider', 'schema', 'internal']);

export const DiagnosticSchema = z.object({
  category: DiagnosticCategorySchema,
  code: z.string().min(1),
  summary: z.string().min(1),
  message: z.string().min(1),
  retriable: z.boolean().optional(),
  providerId: ProviderIdSchema.optional(),
  runtimeId: z.string().min(1).optional(),
  deploymentMode: ProviderDeploymentModeSchema.optional(),
  apiFamily: ProviderApiFamilySchema.optional(),
  stage: z.string().min(1).optional(),
});

export const CacheInfoSchema = z.object({
  status: CacheStatusSchema,
  key: z.string().min(1),
  storage: z.literal('sqlite'),
  createdAt: z.string().datetime().optional(),
  detail: z.string().min(1),
});

export const CostEstimateStatusSchema = z.enum(['exact', 'estimated', 'unknown']);

export const CostEstimateUsageSourceSchema = z.enum(['provider', 'estimated', 'unknown']);

export const CostEstimatePricingSourceSchema = z.enum(['catalog', 'unknown']);

export const CostEstimateSchema = z.object({
  status: CostEstimateStatusSchema,
  currency: z.literal('USD'),
  pricingUnit: z.literal('usd-per-1m-tokens'),
  modelId: z.string().min(1),
  usageSource: CostEstimateUsageSourceSchema,
  pricingSource: CostEstimatePricingSourceSchema,
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  inputCostUsd: z.number().nonnegative().optional(),
  outputCostUsd: z.number().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  detail: z.string().min(1),
});

export const ProviderExecutionResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  outputText: z.string(),
  stopReason: z.string().min(1).optional(),
  usage: ProviderUsageSchema.optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  error: ProviderErrorSchema.optional(),
});

export const PipelineTraceStatusSchema = z.enum(['pending', 'running', 'retrying', 'completed', 'failed', 'skipped']);

export const PipelineTraceMetadataValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const PipelineTraceErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const PipelineTraceEventSchema = z.object({
  stage: z.string().min(1),
  status: PipelineTraceStatusSchema,
  timestamp: z.string().datetime(),
  detail: z.string().optional(),
  metadata: z.record(z.string(), PipelineTraceMetadataValueSchema).default({}),
  error: PipelineTraceErrorSchema.optional(),
});

export const StructuredTaskTypeSchema = z.enum(['refactor', 'debug', 'analysis', 'implementation', 'test', 'other']);

export const TaskTemplateFieldKindSchema = z.enum(['short-text', 'long-text']);
export const TaskTemplateContextStrategyModeSchema = z.enum(['selection-first', 'file-first', 'manual-only']);

export const TaskTemplateContextStrategySchema = z.object({
  mode: TaskTemplateContextStrategyModeSchema,
  includeSupportingContext: z.boolean().default(false),
  maxChars: z.number().int().positive().default(6000),
});

export const TaskTemplateFieldSchema = z.object({
  fieldId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  kind: TaskTemplateFieldKindSchema,
  required: z.boolean().default(false),
  placeholder: z.string().min(1).optional(),
});

export const TaskTemplateDefinitionSchema = z.object({
  templateId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  taskType: StructuredTaskTypeSchema,
  contextStrategy: TaskTemplateContextStrategySchema,
  defaultConstraints: z.array(z.string().min(1)).default([]),
  inputFields: z.array(TaskTemplateFieldSchema).min(1),
});

export const TaskTemplateInputSchema = z.object({
  templateId: z.string().min(1),
  values: z.record(z.string(), z.string()).default({}),
});

export const TaskModelOverrideSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('simple-default'),
  }),
  z.object({
    mode: z.literal('complex-default'),
  }),
  z.object({
    mode: z.literal('specific'),
    modelId: z.string().min(1),
  }),
]);

export const TaskPolicyOverridesSchema = z.object({
  modelOverride: TaskModelOverrideSchema.optional(),
});

export const StructuredTaskTemplateSchema = z.object({
  templateId: z.string().min(1),
  label: z.string().min(1),
  taskType: StructuredTaskTypeSchema,
  defaultConstraints: z.array(z.string().min(1)).default([]),
  values: z.record(z.string(), z.string()).default({}),
});

export const BUILT_IN_TASK_TEMPLATES = z.array(TaskTemplateDefinitionSchema).parse([
  {
    templateId: 'refactor',
    label: 'Refactor',
    description: 'Restructure existing code while keeping requested behavior and public contracts stable.',
    taskType: 'refactor',
    contextStrategy: {
      mode: 'selection-first',
      includeSupportingContext: true,
      maxChars: 6000,
    },
    defaultConstraints: [
      'Keep public API stable unless change is explicitly requested.',
      'Preserve existing behavior unless fixing clearly stated bug.',
    ],
    inputFields: [
      {
        fieldId: 'target',
        label: 'Target code',
        description: 'Selection, file, symbol, or module to refactor.',
        kind: 'short-text',
        required: true,
        placeholder: 'current selection or src/auth.ts',
      },
      {
        fieldId: 'goal',
        label: 'Refactor goal',
        description: 'Main quality goal such as deduplication, readability, or decomposition.',
        kind: 'long-text',
        required: true,
        placeholder: 'reduce duplication and improve readability',
      },
      {
        fieldId: 'guardrails',
        label: 'Guardrails',
        description: 'Extra limits or non-goals.',
        kind: 'long-text',
        required: false,
        placeholder: 'avoid schema changes and keep existing tests intact',
      },
    ],
  },
  {
    templateId: 'debug',
    label: 'Debug',
    description: 'Investigate failure path, isolate root cause, and keep speculation explicit.',
    taskType: 'debug',
    contextStrategy: {
      mode: 'file-first',
      includeSupportingContext: true,
      maxChars: 8000,
    },
    defaultConstraints: [
      'Prioritize root cause over speculative fixes.',
      'Call out missing repro steps or evidence before guessing.',
    ],
    inputFields: [
      {
        fieldId: 'target',
        label: 'Target code',
        description: 'Failing file, symbol, workflow, or subsystem.',
        kind: 'short-text',
        required: true,
        placeholder: 'src/auth.ts login flow',
      },
      {
        fieldId: 'symptom',
        label: 'Observed symptom',
        description: 'Error, failing behavior, or wrong output.',
        kind: 'long-text',
        required: true,
        placeholder: 'token expires immediately after login',
      },
      {
        fieldId: 'reproduction',
        label: 'Reproduction or evidence',
        description: 'Stack trace, logs, or steps to reproduce.',
        kind: 'long-text',
        required: false,
        placeholder: 'open app, log in, see 401 on second request',
      },
    ],
  },
  {
    templateId: 'architecture-analysis',
    label: 'Architecture Analysis',
    description: 'Review architecture, identify high-impact risks, and rank them before proposing changes.',
    taskType: 'analysis',
    contextStrategy: {
      mode: 'file-first',
      includeSupportingContext: false,
      maxChars: 12000,
    },
    defaultConstraints: [
      'Rank risks before proposing remediation.',
      'Do not invent system details that are missing from provided context.',
    ],
    inputFields: [
      {
        fieldId: 'scope',
        label: 'Analysis scope',
        description: 'Repo, subsystem, workflow, or boundary to assess.',
        kind: 'short-text',
        required: true,
        placeholder: 'workspace auth and session boundaries',
      },
      {
        fieldId: 'focus',
        label: 'Risk focus',
        description: 'Lens such as maintainability, scalability, reliability, or coupling.',
        kind: 'long-text',
        required: true,
        placeholder: 'coupling, failure isolation, and scaling bottlenecks',
      },
      {
        fieldId: 'deliverable',
        label: 'Expected output',
        description: 'Preferred output shape such as ranked risks, migration outline, or tradeoff summary.',
        kind: 'long-text',
        required: false,
        placeholder: 'rank top 3 risks and propose minimal remediation path',
      },
    ],
  },
]);

export function getTaskTemplateDefinition(templateId: string) {
  return BUILT_IN_TASK_TEMPLATES.find((definition) => definition.templateId === templateId);
}

export const StructuredTaskTargetKindSchema = z.enum(['selection', 'file', 'symbol', 'workspace', 'unknown']);

export const StructuredTaskTargetSchema = z.object({
  kind: StructuredTaskTargetKindSchema,
  value: z.string().min(1),
  uri: z.string().optional(),
});

export const StructuredTaskSchema = z.object({
  originalTask: z.string().min(1),
  taskType: StructuredTaskTypeSchema,
  goal: z.string().min(1),
  target: StructuredTaskTargetSchema,
  template: StructuredTaskTemplateSchema.optional(),
  qualityBar: QualityBarSchema,
  constraints: z.array(z.string()).default([]),
  expectedOutput: z.array(z.string().min(1)).default([]),
  openQuestions: z.array(z.string()).default([]),
  uncertaintyReasons: z.array(z.string()).default([]),
  contextSummary: z.array(z.string()).default([]),
});

export const StructurizerResultSchema = z.object({
  status: z.enum(['structured', 'fallback']),
  confidence: z.number().min(0).max(1).optional(),
  structuredTask: StructuredTaskSchema,
  fallbackReason: z.string().min(1).optional(),
  warnings: z.array(z.string()).default([]),
});

export const RouteTierSchema = z.enum(['simple', 'complex']);

export const RouteStrategySchema = z.enum(['rules-v1', 'safe-fallback']);

export const RouteScoreFactorSchema = z.object({
  factor: z.string().min(1),
  score: z.number().int().min(0).max(4),
  detail: z.string().min(1),
});

export const RouteDecisionSchema = z.object({
  status: z.enum(['routed', 'fallback']),
  route: RouteTierSchema,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  complexityScore: z.number().int().min(0).max(20),
  scoreBreakdown: z.array(RouteScoreFactorSchema).default([]),
  strategy: RouteStrategySchema.default('rules-v1'),
  fallbackReason: z.string().min(1).optional(),
});

export const PlannerResultStatusSchema = z.enum(['planned', 'fallback']);

export const PlanStepSchema = z.object({
  stepId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptance: z.string().min(1),
});

export const PlanDecisionPointSchema = z.object({
  question: z.string().min(1),
  whyItMatters: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  defaultChoice: z.string().min(1).optional(),
});

export const PlannerDownstreamHintsSchema = z.object({
  reasonerFocus: z.array(z.string().min(1)).default([]),
  verifierChecks: z.array(z.string().min(1)).default([]),
});

export const PlannerResultSchema = z.object({
  status: PlannerResultStatusSchema,
  summary: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
  decisionPoints: z.array(PlanDecisionPointSchema).default([]),
  openQuestions: z.array(z.string().min(1)).default([]),
  downstreamHints: PlannerDownstreamHintsSchema,
  warnings: z.array(z.string().min(1)).default([]),
  fallbackReason: z.string().min(1).optional(),
});

export const ReasonerDecisionSourceSchema = z.enum(['router', 'planner', 'router+planner']);

export const ReasonerInputSchema = z.object({
  taskType: StructuredTaskTypeSchema,
  qualityBar: QualityBarSchema,
  target: z.string().min(1),
  routeReason: z.string().min(1),
  needReasoning: z.boolean(),
  decisionSource: ReasonerDecisionSourceSchema,
  escalationReason: z.string().min(1).optional(),
  earlyExitReason: z.string().min(1).optional(),
  keyContext: z.array(z.string().min(1)).default([]),
  criticalConstraints: z.array(z.string().min(1)).default([]),
  decisionPoints: z.array(z.string().min(1)).default([]),
  plannerFocus: z.array(z.string().min(1)).default([]),
});

export const ReasonerResultStatusSchema = z.enum(['reasoned', 'skipped', 'fallback']);

export const ReasonerResultSchema = z.object({
  status: ReasonerResultStatusSchema,
  needReasoning: z.boolean(),
  decisionSource: ReasonerDecisionSourceSchema,
  escalationReason: z.string().min(1).optional(),
  summary: z.string().min(1),
  keyEvidence: z.array(z.string().min(1)).default([]),
  earlyExitReason: z.string().min(1).optional(),
  warnings: z.array(z.string().min(1)).default([]),
  fallbackReason: z.string().min(1).optional(),
});

export const VerificationVerdictSchema = z.enum(['pass', 'fail', 'warning']);

export const VerificationSuggestedActionSchema = z.enum(['proceed', 'retry', 'upgrade-model', 'manual-confirm']);

export const VerificationKindSchema = z.enum(['model', 'rule']);

export const VerificationFindingSchema = z.object({
  code: z.string().min(1),
  summary: z.string().min(1),
  detail: z.string().min(1),
  severity: VerificationVerdictSchema,
});

export const VerificationResultSchema = z.object({
  verifierId: z.string().min(1),
  verifierKind: VerificationKindSchema,
  verdict: VerificationVerdictSchema,
  summary: z.string().min(1),
  reasons: z.array(z.string().min(1)).default([]),
  suggestedAction: VerificationSuggestedActionSchema,
  findings: z.array(VerificationFindingSchema).default([]),
});

export const TaskRequestSchema = z.object({
  task: z.string().min(1),
  taskType: z.string().min(1).optional(),
  taskTemplate: TaskTemplateInputSchema.optional(),
  qualityBar: QualityBarSchema.default('balanced'),
  cacheMode: CacheModeSchema.default('default'),
  contexts: z.array(TaskContextSchema).default([]),
  constraints: z.array(z.string()).default([]),
  policyOverrides: TaskPolicyOverridesSchema.optional(),
});

export const PipelineExecutionStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export const PipelineGraphSchema = z.enum(['simple-v1', 'complex-v1']);

export const PipelineStageIdSchema = z.enum([
  'request',
  'structurizer',
  'router',
  'planner',
  'reasoner',
  'verifier',
  'executor',
  'response',
]);

export const RerunnableStageIdSchema = z.enum(['structurizer', 'router', 'planner', 'reasoner', 'verifier', 'executor']);

const CountSchema = z.number().int().nonnegative();

export const PipelineStageInputSchema = z.discriminatedUnion('stageId', [
  z.object({
    stageId: z.literal('request'),
    taskChars: CountSchema,
    contextCount: CountSchema,
    constraintCount: CountSchema,
    qualityBar: QualityBarSchema,
  }),
  z.object({
    stageId: z.literal('structurizer'),
    taskChars: CountSchema,
    contextCount: CountSchema,
    templateId: z.string().min(1).optional(),
    primaryContextSource: ContextSourceSchema.optional(),
    supportingContextCount: CountSchema.optional(),
  }),
  z.object({
    stageId: z.literal('router'),
    structurizerStatus: z.enum(['structured', 'fallback']),
    taskType: StructuredTaskTypeSchema,
    openQuestions: CountSchema,
    warningCount: CountSchema,
  }),
  z.object({
    stageId: z.literal('planner'),
    route: RouteTierSchema,
    taskType: StructuredTaskTypeSchema,
    openQuestions: CountSchema,
    constraintCount: CountSchema,
    contextCount: CountSchema,
  }),
  z.object({
    stageId: z.literal('reasoner'),
    route: RouteTierSchema,
    qualityBar: QualityBarSchema,
    plannerAvailable: z.boolean(),
    plannerStatus: z.enum(['planned', 'fallback', 'skipped']).optional(),
    planStepCount: CountSchema,
    needReasoning: z.boolean(),
    decisionSource: ReasonerDecisionSourceSchema.optional(),
    escalationReason: z.string().min(1).optional(),
    earlyExitReason: z.string().min(1).optional(),
    keyContextCount: CountSchema,
    decisionPointCount: CountSchema,
  }),
  z.object({
    stageId: z.literal('verifier'),
    route: RouteTierSchema,
    executorStatus: z.enum(['completed', 'failed']),
    plannerStatus: z.enum(['planned', 'fallback', 'skipped']).optional(),
    planStepCount: CountSchema,
    constraintCount: CountSchema,
    verifierCheckCount: CountSchema,
    outputChars: CountSchema,
  }),
  z.object({
    stageId: z.literal('executor'),
    route: RouteTierSchema,
    providerId: ProviderIdSchema,
    modelId: z.string().min(1),
    runtimeId: z.string().min(1).optional(),
    deploymentMode: ProviderDeploymentModeSchema.optional(),
    apiFamily: ProviderApiFamilySchema.optional(),
  }),
  z.object({
    stageId: z.literal('response'),
    providerStatus: z.enum(['completed', 'failed']),
    costStatus: CostEstimateStatusSchema,
    diagnosticPresent: z.boolean(),
  }),
]);

export const PipelineStageOutputSchema = z.discriminatedUnion('stageId', [
  z.object({
    stageId: z.literal('request'),
    accepted: z.literal(true),
  }),
  z.object({
    stageId: z.literal('structurizer'),
    status: z.enum(['structured', 'fallback']),
    taskType: StructuredTaskTypeSchema,
    targetKind: StructuredTaskTargetKindSchema,
    warningCount: CountSchema,
    expectedOutputCount: CountSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    fallbackReason: z.string().min(1).optional(),
  }),
  z.object({
    stageId: z.literal('router'),
    status: z.enum(['routed', 'fallback']),
    route: RouteTierSchema,
    complexityScore: CountSchema,
    confidence: z.number().min(0).max(1),
    fallbackReason: z.string().min(1).optional(),
  }),
  z.object({
    stageId: z.literal('planner'),
    status: z.enum(['planned', 'fallback', 'skipped']),
    summary: z.string().min(1),
    planStepCount: CountSchema,
    decisionPointCount: CountSchema,
    openQuestionCount: CountSchema,
    downstreamHintCount: CountSchema,
    detail: z.string().min(1),
    fallbackReason: z.string().min(1).optional(),
  }),
  z.object({
    stageId: z.literal('reasoner'),
    status: z.enum(['reasoned', 'skipped', 'fallback']),
    needReasoning: z.boolean(),
    decisionSource: ReasonerDecisionSourceSchema,
    summary: z.string().min(1),
    keyEvidenceCount: CountSchema,
    detail: z.string().min(1),
    escalationReason: z.string().min(1).optional(),
    earlyExitReason: z.string().min(1).optional(),
    fallbackReason: z.string().min(1).optional(),
  }),
  z.object({
    stageId: z.literal('verifier'),
    status: z.enum(['completed', 'skipped']),
    detail: z.string().min(1),
    result: VerificationResultSchema.optional(),
  }),
  z.object({
    stageId: z.literal('executor'),
    status: z.enum(['completed', 'failed']),
    providerId: ProviderIdSchema,
    modelId: z.string().min(1),
    latencyMs: CountSchema.optional(),
    errorCode: ProviderErrorCodeSchema.optional(),
  }),
  z.object({
    stageId: z.literal('response'),
    outputChars: CountSchema,
    providerStatus: z.enum(['completed', 'failed']),
    costStatus: CostEstimateStatusSchema,
    diagnosticCode: z.string().min(1).optional(),
  }),
]);

export const PipelineStageStateSchema = z.object({
  stageId: PipelineStageIdSchema,
  label: z.string().min(1),
  state: PipelineExecutionStateSchema,
  dependsOn: z.array(PipelineStageIdSchema).default([]),
  input: PipelineStageInputSchema.optional(),
  output: PipelineStageOutputSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  skippedReason: z.string().min(1).optional(),
  error: PipelineTraceErrorSchema.optional(),
});

export const PipelineStateTransitionSchema = z.object({
  stageId: PipelineStageIdSchema,
  fromState: PipelineExecutionStateSchema,
  toState: PipelineExecutionStateSchema,
  timestamp: z.string().datetime(),
  detail: z.string().min(1).optional(),
});

export const PipelineStateSchema = z.object({
  version: z.literal('v1'),
  graph: PipelineGraphSchema,
  route: RouteTierSchema,
  state: PipelineExecutionStateSchema,
  currentStageId: PipelineStageIdSchema.optional(),
  stages: z.array(PipelineStageStateSchema),
  transitions: z.array(PipelineStateTransitionSchema).default([]),
});

export const TaskExecutionModeSchema = z.enum(['full', 'stage-rerun']);

export const TaskRunInfoSchema = z.object({
  mode: TaskExecutionModeSchema,
  targetStageId: RerunnableStageIdSchema.optional(),
  reusedCheckpointStages: z.array(RerunnableStageIdSchema).default([]),
  historyTraceCount: CountSchema,
  historyTransitionCount: CountSchema,
  detail: z.string().min(1),
});

export const PipelineCheckpointSchema = z.object({
  taskRequest: TaskRequestSchema,
  structurizerResult: StructurizerResultSchema.optional(),
  routeDecision: RouteDecisionSchema.optional(),
  plannerResult: PlannerResultSchema.optional(),
  reasonerResult: ReasonerResultSchema.optional(),
  verifierResult: VerificationResultSchema.optional(),
  output: z.string().min(1).optional(),
  providerResult: ProviderExecutionResultSchema.optional(),
  costEstimate: CostEstimateSchema.optional(),
  diagnostic: DiagnosticSchema.optional(),
  pipeline: PipelineStateSchema,
  trace: z.array(PipelineTraceEventSchema),
  capturedAt: z.string().datetime(),
});

export const RerunTaskRequestSchema = z.object({
  targetStageId: RerunnableStageIdSchema,
  checkpoint: PipelineCheckpointSchema,
});

export const TaskResponseSchema = z.object({
  output: z.string().min(1),
  runInfo: TaskRunInfoSchema,
  routeDecision: RouteDecisionSchema,
  plannerResult: PlannerResultSchema.optional(),
  reasonerResult: ReasonerResultSchema.optional(),
  verifierResult: VerificationResultSchema.optional(),
  selectedProvider: ProviderSelectionSchema,
  providerResult: ProviderExecutionResultSchema,
  costEstimate: CostEstimateSchema,
  cacheInfo: CacheInfoSchema.optional(),
  diagnostic: DiagnosticSchema.optional(),
  pipeline: PipelineStateSchema,
  trace: z.array(PipelineTraceEventSchema),
  checkpoint: PipelineCheckpointSchema,
});

export const OrchestratorRequestSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('health'),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('runTask'),
    request: TaskRequestSchema,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('rerunTask'),
    rerun: RerunTaskRequestSchema,
  }),
]);

export const OrchestratorEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    transport: TransportSchema,
    detail: z.string().min(1).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('healthResult'),
    status: z.literal('ok'),
    detail: z.string().min(1).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('taskResult'),
    response: TaskResponseSchema,
  }),
  z.object({
    type: z.literal('error'),
    id: z.string().min(1).optional(),
    message: z.string().min(1),
    diagnostic: DiagnosticSchema.optional(),
  }),
]);

export const RuntimeConfigSchema = z.object({
  defaultSimpleModel: z.string().min(1),
  defaultComplexModel: z.string().min(1),
  transport: TransportSchema.default('stdio'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  providerKeys: z.object({
    openai: z.string().min(1).optional(),
    anthropic: z.string().min(1).optional(),
    deepseek: z.string().min(1).optional(),
    gemini: z.string().min(1).optional(),
  }),
  runtimeProfiles: z.array(ProviderRuntimeProfileSchema).default([]),
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type Transport = z.infer<typeof TransportSchema>;
export type QualityBar = z.infer<typeof QualityBarSchema>;
export type CacheMode = z.infer<typeof CacheModeSchema>;
export type ProviderDeploymentMode = z.infer<typeof ProviderDeploymentModeSchema>;
export type ProviderApiFamily = z.infer<typeof ProviderApiFamilySchema>;
export type ProviderAuthMode = z.infer<typeof ProviderAuthModeSchema>;
export type ContextSource = z.infer<typeof ContextSourceSchema>;
export type TaskContext = z.infer<typeof TaskContextSchema>;
export type ProviderSelection = z.infer<typeof ProviderSelectionSchema>;
export type ProviderRuntimeProfile = z.infer<typeof ProviderRuntimeProfileSchema>;
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;
export type ProviderError = z.infer<typeof ProviderErrorSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
export type CacheStatus = z.infer<typeof CacheStatusSchema>;
export type DiagnosticCategory = z.infer<typeof DiagnosticCategorySchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type CacheInfo = z.infer<typeof CacheInfoSchema>;
export type CostEstimateStatus = z.infer<typeof CostEstimateStatusSchema>;
export type CostEstimateUsageSource = z.infer<typeof CostEstimateUsageSourceSchema>;
export type CostEstimatePricingSource = z.infer<typeof CostEstimatePricingSourceSchema>;
export type CostEstimate = z.infer<typeof CostEstimateSchema>;
export type ProviderExecutionResult = z.infer<typeof ProviderExecutionResultSchema>;
export type PipelineTraceStatus = z.infer<typeof PipelineTraceStatusSchema>;
export type PipelineTraceMetadataValue = z.infer<typeof PipelineTraceMetadataValueSchema>;
export type PipelineTraceError = z.infer<typeof PipelineTraceErrorSchema>;
export type PipelineTraceEvent = z.infer<typeof PipelineTraceEventSchema>;
export type StructuredTaskType = z.infer<typeof StructuredTaskTypeSchema>;
export type ContextPriority = z.infer<typeof ContextPrioritySchema>;
export type TaskTemplateFieldKind = z.infer<typeof TaskTemplateFieldKindSchema>;
export type TaskTemplateContextStrategyMode = z.infer<typeof TaskTemplateContextStrategyModeSchema>;
export type TaskTemplateContextStrategy = z.infer<typeof TaskTemplateContextStrategySchema>;
export type TaskTemplateField = z.infer<typeof TaskTemplateFieldSchema>;
export type TaskTemplateDefinition = z.infer<typeof TaskTemplateDefinitionSchema>;
export type TaskTemplateInput = z.infer<typeof TaskTemplateInputSchema>;
export type TaskModelOverride = z.infer<typeof TaskModelOverrideSchema>;
export type TaskPolicyOverrides = z.infer<typeof TaskPolicyOverridesSchema>;
export type StructuredTaskTemplate = z.infer<typeof StructuredTaskTemplateSchema>;
export type StructuredTaskTargetKind = z.infer<typeof StructuredTaskTargetKindSchema>;
export type StructuredTaskTarget = z.infer<typeof StructuredTaskTargetSchema>;
export type StructuredTask = z.infer<typeof StructuredTaskSchema>;
export type StructurizerResult = z.infer<typeof StructurizerResultSchema>;
export type RouteTier = z.infer<typeof RouteTierSchema>;
export type RouteStrategy = z.infer<typeof RouteStrategySchema>;
export type RouteScoreFactor = z.infer<typeof RouteScoreFactorSchema>;
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
export type PlannerResultStatus = z.infer<typeof PlannerResultStatusSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanDecisionPoint = z.infer<typeof PlanDecisionPointSchema>;
export type PlannerDownstreamHints = z.infer<typeof PlannerDownstreamHintsSchema>;
export type PlannerResult = z.infer<typeof PlannerResultSchema>;
export type ReasonerDecisionSource = z.infer<typeof ReasonerDecisionSourceSchema>;
export type ReasonerInput = z.infer<typeof ReasonerInputSchema>;
export type ReasonerResultStatus = z.infer<typeof ReasonerResultStatusSchema>;
export type ReasonerResult = z.infer<typeof ReasonerResultSchema>;
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;
export type VerificationSuggestedAction = z.infer<typeof VerificationSuggestedActionSchema>;
export type VerificationKind = z.infer<typeof VerificationKindSchema>;
export type VerificationFinding = z.infer<typeof VerificationFindingSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type PipelineExecutionState = z.infer<typeof PipelineExecutionStateSchema>;
export type PipelineGraph = z.infer<typeof PipelineGraphSchema>;
export type PipelineStageId = z.infer<typeof PipelineStageIdSchema>;
export type RerunnableStageId = z.infer<typeof RerunnableStageIdSchema>;
export type PipelineStageInput = z.infer<typeof PipelineStageInputSchema>;
export type PipelineStageOutput = z.infer<typeof PipelineStageOutputSchema>;
export type PipelineStageState = z.infer<typeof PipelineStageStateSchema>;
export type PipelineStateTransition = z.infer<typeof PipelineStateTransitionSchema>;
export type PipelineState = z.infer<typeof PipelineStateSchema>;
export type TaskExecutionMode = z.infer<typeof TaskExecutionModeSchema>;
export type TaskRunInfo = z.infer<typeof TaskRunInfoSchema>;
export type PipelineCheckpoint = z.infer<typeof PipelineCheckpointSchema>;
export type RerunTaskRequest = z.infer<typeof RerunTaskRequestSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type OrchestratorRequest = z.infer<typeof OrchestratorRequestSchema>;
export type OrchestratorEvent = z.infer<typeof OrchestratorEventSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;