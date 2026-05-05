import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'deepseek', 'gemini']);
export const TransportSchema = z.enum(['stdio', 'ipc']);
export const QualityBarSchema = z.enum(['fast', 'balanced', 'high']);

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

export const PipelineTraceEventSchema = z.object({
  stage: z.string().min(1),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  timestamp: z.string().datetime(),
  detail: z.string().optional(),
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
  contexts: z.array(TaskContextSchema).default([]),
  constraints: z.array(z.string()).default([]),
  policyOverrides: z.record(z.string(), z.unknown()).optional(),
});

export const TaskResponseSchema = z.object({
  output: z.string().min(1),
  routeDecision: RouteDecisionSchema,
  selectedProvider: ProviderSelectionSchema,
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
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type Transport = z.infer<typeof TransportSchema>;
export type QualityBar = z.infer<typeof QualityBarSchema>;
export type ContextSource = z.infer<typeof ContextSourceSchema>;
export type TaskContext = z.infer<typeof TaskContextSchema>;
export type ProviderSelection = z.infer<typeof ProviderSelectionSchema>;
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