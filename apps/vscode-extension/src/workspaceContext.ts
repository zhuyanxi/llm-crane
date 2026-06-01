import {
  ContextSourceRegistryEntrySchema,
  type ContextBudgetStage,
  type ContextSource,
  type ContextSourceRegistryEntry,
  type TaskContext,
} from '@llm-crane/schemas';

export type RegisteredContextInput = {
  source: ContextSource;
  content: string;
  priority?: TaskContext['priority'];
  uri?: string;
  languageId?: string;
  command?: string;
  locked?: boolean;
  capturedAt?: string;
};

export type ContextRelevanceInput = {
  task: string;
  taskType?: string;
  templateId?: string;
  constraints?: string[];
  contexts: TaskContext[];
};

export type ContextBudgetPolicy = Record<ContextBudgetStage, number>;

export type ContextPruningStageSummary = {
  stage: ContextBudgetStage;
  budgetTokens: number;
  selectedCount: number;
  totalCount: number;
  selectedTokens: number;
  droppedCount: number;
  lockedCount: number;
  detail: string;
};

export type ContextPruningResult = {
  contexts: TaskContext[];
  stageSummaries: ContextPruningStageSummary[];
  warnings: string[];
};

const TOKEN_CHAR_RATIO = 4;
const RELEVANCE_PRECISION = 100;
const TOKEN_WORD_PATTERN = /[a-z0-9_./:-]{3,}/gi;
const ERROR_STACK_PATTERN = /\b(error|exception|traceback|stack trace|at\s+\S+\s+\(|failed|failure)\b/i;

export const DEFAULT_CONTEXT_BUDGET_POLICY: ContextBudgetPolicy = {
  structurizer: 900,
  planner: 1600,
  reasoner: 2400,
};

export const BUILT_IN_CONTEXT_SOURCE_REGISTRY: ContextSourceRegistryEntry[] = [
  {
    source: 'file',
    label: 'File',
    description: 'Editor file content from current workspace.',
    defaultPriority: 'primary',
    supportsUri: true,
    supportsLanguageId: true,
    supportsCommand: false,
  },
  {
    source: 'selection',
    label: 'Selection',
    description: 'Active editor selection.',
    defaultPriority: 'primary',
    supportsUri: true,
    supportsLanguageId: true,
    supportsCommand: false,
  },
  {
    source: 'terminal',
    label: 'Terminal output',
    description: 'User-provided terminal output, error log, or stack trace.',
    defaultPriority: 'supporting',
    supportsUri: false,
    supportsLanguageId: false,
    supportsCommand: true,
  },
  {
    source: 'user',
    label: 'User notes',
    description: 'Supplemental user instructions or facts that should travel with task context.',
    defaultPriority: 'supporting',
    supportsUri: false,
    supportsLanguageId: false,
    supportsCommand: false,
  },
  {
    source: 'workspace',
    label: 'Workspace summary',
    description: 'Workspace-level summary or curated multi-file context.',
    defaultPriority: 'supporting',
    supportsUri: true,
    supportsLanguageId: false,
    supportsCommand: false,
  },
  {
    source: 'manual',
    label: 'Manual context',
    description: 'Legacy manually supplied context.',
    defaultPriority: 'supporting',
    supportsUri: false,
    supportsLanguageId: false,
    supportsCommand: false,
  },
];

function normalizeContent(value: string): string {
  return value.trim();
}

function stableSourceId(input: RegisteredContextInput, index: number): string {
  const uriSuffix = input.uri ? `:${input.uri.split('/').filter(Boolean).at(-1) ?? input.uri}` : '';
  return `${input.source}:${index + 1}${uriSuffix}`;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * RELEVANCE_PRECISION) / RELEVANCE_PRECISION));
}

function tokenize(value: string): string[] {
  return [...value.toLowerCase().matchAll(TOKEN_WORD_PATTERN)].map((match) => match[0]);
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

function countOverlap(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function sourcePriorityScore(context: TaskContext): number {
  if (context.locked) {
    return 1;
  }

  if ((context.priority ?? 'primary') === 'primary') {
    return 0.9;
  }

  switch (context.source) {
    case 'selection':
      return 0.85;
    case 'file':
    case 'workspace':
      return 0.7;
    case 'terminal':
      return 0.65;
    case 'user':
    case 'manual':
      return 0.75;
  }
}

function templateAffinityScore(context: TaskContext, input: ContextRelevanceInput): { score: number; detail: string } {
  const taskType = input.taskType ?? input.templateId ?? '';

  if (taskType === 'debug' && context.source === 'terminal') {
    return { score: 1, detail: 'debug task favors terminal/error evidence' };
  }

  if (taskType === 'refactor' && (context.source === 'selection' || context.source === 'file')) {
    return { score: 0.85, detail: 'refactor task favors selected code and containing file' };
  }

  if ((taskType === 'analysis' || input.templateId === 'architecture-analysis') && (context.source === 'workspace' || context.source === 'file')) {
    return { score: 0.8, detail: 'analysis task favors file/workspace context' };
  }

  if (context.source === 'user') {
    return { score: 0.75, detail: 'user notes can carry explicit task facts' };
  }

  return { score: 0.45, detail: 'generic source affinity' };
}

function keywordScore(context: TaskContext, input: ContextRelevanceInput): { score: number; detail: string } {
  const queryTokens = uniqueTokens([input.task, ...(input.constraints ?? [])].join(' '));
  const contextTokens = uniqueTokens([context.uri ?? '', context.content].join(' '));

  if (queryTokens.length === 0 || contextTokens.length === 0) {
    return { score: 0.5, detail: 'no keyword evidence available' };
  }

  const overlap = countOverlap(queryTokens, contextTokens);
  const score = clampScore(overlap / Math.min(queryTokens.length, 10));
  return {
    score,
    detail: overlap > 0 ? `${overlap} task keyword(s) matched` : 'no direct task keyword match',
  };
}

function pathMentionScore(context: TaskContext, input: ContextRelevanceInput): { score: number; detail: string } {
  if (!context.uri) {
    return { score: 0.35, detail: 'no path metadata' };
  }

  const filename = context.uri.split('/').filter(Boolean).at(-1) ?? context.uri;
  const normalizedTask = input.task.toLowerCase();

  if (normalizedTask.includes(context.uri.toLowerCase()) || normalizedTask.includes(filename.toLowerCase())) {
    return { score: 1, detail: `task mentions ${filename}` };
  }

  return { score: 0.45, detail: `task does not mention ${filename}` };
}

function errorStackScore(context: TaskContext, input: ContextRelevanceInput): { score: number; detail: string } {
  const taskLooksDebug = /\b(debug|fix|bug|error|failing|failure|trace|stack)\b/i.test(input.task);
  const contextLooksError = ERROR_STACK_PATTERN.test(context.content);

  if (taskLooksDebug && contextLooksError) {
    return { score: 1, detail: 'debug task matches error/stack context' };
  }

  if (contextLooksError) {
    return { score: 0.7, detail: 'context contains error/stack signal' };
  }

  return { score: 0.35, detail: 'no error-stack signal' };
}

export function createWorkspaceContextSourceRegistry(
  entries: ContextSourceRegistryEntry[] = BUILT_IN_CONTEXT_SOURCE_REGISTRY,
): Map<ContextSource, ContextSourceRegistryEntry> {
  const registry = new Map<ContextSource, ContextSourceRegistryEntry>();

  for (const rawEntry of entries) {
    const entry = ContextSourceRegistryEntrySchema.parse(rawEntry);
    if (registry.has(entry.source)) {
      throw new Error(`Duplicate context source registry entry: ${entry.source}`);
    }
    registry.set(entry.source, entry);
  }

  return registry;
}

export function createRegisteredTaskContext(
  input: RegisteredContextInput,
  index = 0,
  registry = createWorkspaceContextSourceRegistry(),
): TaskContext {
  const entry = registry.get(input.source);
  if (!entry) {
    throw new Error(`Unknown context source: ${input.source}`);
  }

  const content = normalizeContent(input.content);
  if (!content) {
    throw new Error(`Context source ${input.source} requires non-empty content.`);
  }

  return {
    source: input.source,
    priority: input.priority ?? entry.defaultPriority,
    uri: entry.supportsUri ? input.uri : undefined,
    languageId: entry.supportsLanguageId ? input.languageId : undefined,
    content,
    truncated: false,
    locked: input.locked ?? false,
    sourceMetadata: {
      sourceId: stableSourceId(input, index),
      source: input.source,
      label: entry.label,
      description: entry.description,
      uri: entry.supportsUri ? input.uri : undefined,
      languageId: entry.supportsLanguageId ? input.languageId : undefined,
      command: entry.supportsCommand ? input.command : undefined,
      capturedAt: input.capturedAt,
    },
  };
}

export function estimateContextTokens(context: Pick<TaskContext, 'content'>): number {
  return Math.ceil(context.content.length / TOKEN_CHAR_RATIO);
}

export function scoreContextRelevance(input: ContextRelevanceInput): TaskContext[] {
  try {
    const scoredContexts = input.contexts.map((context, originalIndex) => {
      const keyword = keywordScore(context, input);
      const template = templateAffinityScore(context, input);
      const pathMention = pathMentionScore(context, input);
      const errorStack = errorStackScore(context, input);
      const sourcePriority = sourcePriorityScore(context);
      const score = clampScore(
        keyword.score * 0.35
        + template.score * 0.2
        + pathMention.score * 0.15
        + errorStack.score * 0.15
        + sourcePriority * 0.15,
      );

      return {
        context: {
          ...context,
          relevance: {
            score,
            summary: `score=${score}; ${keyword.detail}; ${template.detail}`,
            factors: [
              { factor: 'keyword-match', score: keyword.score, detail: keyword.detail },
              { factor: 'task-template', score: template.score, detail: template.detail },
              { factor: 'path-mention', score: pathMention.score, detail: pathMention.detail },
              { factor: 'error-stack', score: errorStack.score, detail: errorStack.detail },
              { factor: 'source-priority', score: sourcePriority, detail: `${context.source}/${context.priority ?? 'primary'} priority` },
            ],
          },
        } satisfies TaskContext,
        originalIndex,
      };
    });

    return scoredContexts
      .sort((left, right) => {
        if (left.context.locked !== right.context.locked) {
          return left.context.locked ? -1 : 1;
        }

        const scoreDifference = (right.context.relevance?.score ?? 0) - (left.context.relevance?.score ?? 0);
        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return left.originalIndex - right.originalIndex;
      })
      .map(({ context }, index) => ({
        ...context,
        relevance: context.relevance
          ? {
              ...context.relevance,
              rank: index + 1,
            }
          : undefined,
      }));
  } catch {
    return input.contexts.map((context, index) => ({
      ...context,
      relevance: {
        score: clampScore(context.locked ? 1 : 0.5),
        rank: index + 1,
        summary: 'Conservative fallback ranking after relevance scoring failed.',
        factors: [
          {
            factor: 'fallback-order',
            score: context.locked ? 1 : 0.5,
            detail: 'Preserved original collector order.',
          },
        ],
      },
    }));
  }
}

function selectContextsForStage(contexts: TaskContext[], stage: ContextBudgetStage, budgetTokens: number) {
  const selected = new Set<string>();
  let selectedTokens = 0;
  const sourceId = (context: TaskContext, index: number) => context.sourceMetadata?.sourceId ?? `${context.source}:${index}`;

  contexts.forEach((context, index) => {
    if (!context.locked) {
      return;
    }

    selected.add(sourceId(context, index));
    selectedTokens += estimateContextTokens(context);
  });

  contexts.forEach((context, index) => {
    const id = sourceId(context, index);
    if (selected.has(id)) {
      return;
    }

    const estimatedTokens = estimateContextTokens(context);
    if (selectedTokens + estimatedTokens <= budgetTokens) {
      selected.add(id);
      selectedTokens += estimatedTokens;
    }
  });

  return {
    stage,
    selected,
    selectedTokens,
  };
}

export function applyContextBudgetPruning(
  contexts: TaskContext[],
  policy: ContextBudgetPolicy = DEFAULT_CONTEXT_BUDGET_POLICY,
): ContextPruningResult {
  const stageSelections = (Object.keys(policy) as ContextBudgetStage[]).map((stage) => selectContextsForStage(contexts, stage, policy[stage]));
  const reasonerSelection = stageSelections.find((selection) => selection.stage === 'reasoner') ?? stageSelections.at(-1);
  const warnings: string[] = [];
  const contextIds = contexts.map((context, index) => context.sourceMetadata?.sourceId ?? `${context.source}:${index}`);
  const prunedContexts = contexts.map((context, index) => {
    const id = contextIds[index] as string;
    const includedStages = stageSelections
      .filter((selection) => selection.selected.has(id))
      .map((selection) => selection.stage);
    const included = reasonerSelection?.selected.has(id) ?? true;
    const estimatedTokens = estimateContextTokens(context);
    const reason = context.locked
      ? 'Locked by user; preserved before relevance pruning.'
      : included
        ? `Selected by relevance rank ${context.relevance?.rank ?? index + 1}.`
        : `Dropped by relevance rank ${context.relevance?.rank ?? index + 1} to fit reasoner budget.`;

    return {
      ...context,
      pruning: {
        locked: context.locked ?? false,
        included,
        includedStages,
        estimatedTokens,
        reason,
      },
    } satisfies TaskContext;
  });

  for (const context of prunedContexts) {
    if (context.locked && context.pruning && context.pruning.includedStages.length < stageSelections.length) {
      warnings.push(`${context.source} context is locked but exceeds at least one stage budget.`);
    }
  }

  for (const selection of stageSelections) {
    const budgetTokens = policy[selection.stage];
    if (selection.selectedTokens > budgetTokens) {
      warnings.push(`${selection.stage} context budget exceeded by locked context: ${selection.selectedTokens}/${budgetTokens} tokens.`);
    }
  }

  const stageSummaries: ContextPruningStageSummary[] = stageSelections.map((selection) => {
    const budgetTokens = policy[selection.stage];
    const droppedCount = contexts.length - selection.selected.size;
    return {
      stage: selection.stage,
      budgetTokens,
      selectedCount: selection.selected.size,
      totalCount: contexts.length,
      selectedTokens: selection.selectedTokens,
      droppedCount,
      lockedCount: contexts.filter((context) => context.locked).length,
      detail: droppedCount > 0
        ? `${selection.stage} kept ${selection.selected.size}/${contexts.length} context item(s) inside ${budgetTokens} token budget.`
        : `${selection.stage} kept all ${contexts.length} context item(s) inside ${budgetTokens} token budget.`,
    };
  });

  return {
    contexts: prunedContexts.filter((context) => context.pruning?.included ?? true),
    stageSummaries,
    warnings,
  };
}
