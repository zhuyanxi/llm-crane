import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'deepseek', 'gemini']);

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

export const TaskRequestSchema = z.object({
  task: z.string().min(1),
  taskType: z.string().min(1).optional(),
  qualityBar: z.enum(['fast', 'balanced', 'high']).default('balanced'),
  contexts: z.array(TaskContextSchema).default([]),
  constraints: z.array(z.string()).default([]),
  policyOverrides: z.record(z.string(), z.unknown()).optional(),
});

export const TaskResponseSchema = z.object({
  output: z.string().min(1),
  selectedProvider: ProviderSelectionSchema,
  trace: z.array(PipelineTraceEventSchema),
});

export const RuntimeConfigSchema = z.object({
  defaultSimpleModel: z.string().min(1),
  defaultComplexModel: z.string().min(1),
  transport: z.enum(['stdio', 'ipc']).default('stdio'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  providerKeys: z.object({
    openai: z.string().min(1).optional(),
    anthropic: z.string().min(1).optional(),
    deepseek: z.string().min(1).optional(),
    gemini: z.string().min(1).optional(),
  }),
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type ContextSource = z.infer<typeof ContextSourceSchema>;
export type TaskContext = z.infer<typeof TaskContextSchema>;
export type ProviderSelection = z.infer<typeof ProviderSelectionSchema>;
export type PipelineTraceEvent = z.infer<typeof PipelineTraceEventSchema>;
export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;