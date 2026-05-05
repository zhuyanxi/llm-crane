import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'deepseek', 'gemini', 'ollama']);
export const TransportSchema = z.enum(['stdio', 'ipc']);
export const QualityBarSchema = z.enum(['fast', 'balanced', 'high']);
export const CacheModeSchema = z.enum(['default', 'bypass']);
export const ProviderDeploymentModeSchema = z.enum(['hosted', 'local']);
export const ProviderApiFamilySchema = z.enum(['openai-compatible', 'anthropic', 'gemini', 'ollama']);
export const ProviderAuthModeSchema = z.enum(['none', 'bearer', 'header', 'query']);

export const ContextSourceSchema = z.enum(['manual', 'selection', 'file', 'workspace']);

export const TaskContextSchema = z.object({
  source: ContextSourceSchema,
  uri: z.string().optional(),
  languageId: z.string().optional(),
  content: z.string().min(1),
});

export const ProviderSelectionSchema = z.object({
  providerId: ProviderIdSchema,
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
  qualityBar: QualityBarSchema,
  constraints: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  uncertaintyReasons: z.array(z.string()).default([]),
  contextSummary: z.array(z.string()).default([]),
});

export const StructurizerResultSchema = z.object({
  status: z.enum(['structured', 'fallback']),
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

export const TaskRequestSchema = z.object({
  task: z.string().min(1),
  taskType: z.string().min(1).optional(),
  qualityBar: QualityBarSchema.default('balanced'),
  cacheMode: CacheModeSchema.default('default'),
  contexts: z.array(TaskContextSchema).default([]),
  constraints: z.array(z.string()).default([]),
  policyOverrides: z.record(z.string(), z.unknown()).optional(),
});

export const TaskResponseSchema = z.object({
  output: z.string().min(1),
  routeDecision: RouteDecisionSchema,
  selectedProvider: ProviderSelectionSchema,
  providerResult: ProviderExecutionResultSchema,
  costEstimate: CostEstimateSchema,
  cacheInfo: CacheInfoSchema.optional(),
  diagnostic: DiagnosticSchema.optional(),
  trace: z.array(PipelineTraceEventSchema),
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
export type StructuredTaskTargetKind = z.infer<typeof StructuredTaskTargetKindSchema>;
export type StructuredTaskTarget = z.infer<typeof StructuredTaskTargetSchema>;
export type StructuredTask = z.infer<typeof StructuredTaskSchema>;
export type StructurizerResult = z.infer<typeof StructurizerResultSchema>;
export type RouteTier = z.infer<typeof RouteTierSchema>;
export type RouteStrategy = z.infer<typeof RouteStrategySchema>;
export type RouteScoreFactor = z.infer<typeof RouteScoreFactorSchema>;
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type OrchestratorRequest = z.infer<typeof OrchestratorRequestSchema>;
export type OrchestratorEvent = z.infer<typeof OrchestratorEventSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;