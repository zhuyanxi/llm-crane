import type {
  TaskContext,
  TaskTemplateContextStrategy,
  TaskTemplateContextStrategyMode,
} from '@llm-crane/schemas';
import {
  applyContextBudgetPruning,
  createRegisteredTaskContext,
  scoreContextRelevance,
  type ContextBudgetPolicy,
  type ContextPruningStageSummary,
} from './workspaceContext';

export type ContextCaptureMode = 'template-default' | 'selection-first' | 'file-first' | 'manual-only';

export type EditorContextSnapshot = {
  uri: string;
  languageId: string;
  selectionContent: string;
  fileContent: string;
};

export type PlannedContextResult = {
  effectiveStrategy: TaskTemplateContextStrategy;
  contexts: TaskContext[];
  warnings: string[];
  pruningSummary?: ContextPruningStageSummary[];
  blockingError?: string;
};

export type SupplementalContextSources = {
  terminalOutput?: string;
  terminalCommand?: string;
  userNotes?: string;
};

export type TaskContextPlanningOptions = {
  task?: string;
  taskType?: string;
  templateId?: string;
  constraints?: string[];
  lockPrimaryContext?: boolean;
  supplementalSources?: SupplementalContextSources;
  budgetPolicy?: ContextBudgetPolicy;
};

const DEFAULT_CONTEXT_STRATEGY: TaskTemplateContextStrategy = {
  mode: 'selection-first',
  includeSupportingContext: false,
  maxChars: 6000,
};

function normalizeContent(value: string): string {
  return value.trim();
}

function createTruncationSuffix(removedChars: number): string {
  return `\n...[truncated ${removedChars} chars]`;
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean; originalLength?: number } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  const suffix = createTruncationSuffix(content.length - maxChars);
  const sliceLength = Math.max(0, maxChars - suffix.length);

  return {
    content: `${content.slice(0, sliceLength)}${suffix}`,
    truncated: true,
    originalLength: content.length,
  };
}

function createTaskContext(
  snapshot: EditorContextSnapshot,
  source: TaskContext['source'],
  priority: TaskContext['priority'],
  rawContent: string,
  maxChars: number,
  locked: boolean,
  index: number,
): TaskContext {
  const truncatedContent = truncateContent(rawContent, maxChars);
  const context = createRegisteredTaskContext(
    {
      source,
      priority,
      uri: snapshot.uri,
      languageId: snapshot.languageId,
      content: truncatedContent.content,
      locked,
    },
    index,
  );

  return {
    ...context,
    truncated: truncatedContent.truncated,
    originalLength: truncatedContent.originalLength,
  };
}

function shouldIncludeSupportingContext(primaryContent: string, supportingContent: string): boolean {
  return normalizeContent(primaryContent) !== normalizeContent(supportingContent);
}

export function resolveContextStrategy(
  captureMode: ContextCaptureMode,
  templateStrategy?: TaskTemplateContextStrategy,
  includeSupportingContextOverride?: boolean,
): TaskTemplateContextStrategy {
  const baseStrategy = templateStrategy ?? DEFAULT_CONTEXT_STRATEGY;

  if (captureMode === 'template-default') {
    return {
      ...baseStrategy,
      includeSupportingContext: includeSupportingContextOverride ?? baseStrategy.includeSupportingContext,
    };
  }

  if (captureMode === 'manual-only') {
    return {
      mode: 'manual-only',
      includeSupportingContext: false,
      maxChars: baseStrategy.maxChars,
    };
  }

  return {
    mode: captureMode,
    includeSupportingContext: includeSupportingContextOverride ?? baseStrategy.includeSupportingContext,
    maxChars: baseStrategy.maxChars,
  };
}

function addTruncationWarnings(contexts: TaskContext[], warnings: string[]): void {
  for (const context of contexts) {
    if (context.truncated && context.originalLength) {
      warnings.push(
        `${context.source} context truncated to ${context.content.length} chars from ${context.originalLength} chars.`,
      );
    }
  }
}

function appendSupplementalContexts(
  contexts: TaskContext[],
  warnings: string[],
  strategy: TaskTemplateContextStrategy,
  options?: TaskContextPlanningOptions,
): void {
  const terminalOutput = normalizeContent(options?.supplementalSources?.terminalOutput ?? '');
  const userNotes = normalizeContent(options?.supplementalSources?.userNotes ?? '');
  const supplementalContexts: TaskContext[] = [];

  if (terminalOutput.length > 0) {
    const truncatedContent = truncateContent(terminalOutput, strategy.maxChars);
    supplementalContexts.push({
      ...createRegisteredTaskContext(
        {
          source: 'terminal',
          priority: 'supporting',
          content: truncatedContent.content,
          command: normalizeContent(options?.supplementalSources?.terminalCommand ?? '') || 'user-provided-terminal-output',
        },
        contexts.length,
      ),
      truncated: truncatedContent.truncated,
      originalLength: truncatedContent.originalLength,
    });
  }

  if (userNotes.length > 0) {
    const truncatedContent = truncateContent(userNotes, strategy.maxChars);
    supplementalContexts.push({
      ...createRegisteredTaskContext(
        {
          source: 'user',
          priority: 'supporting',
          content: truncatedContent.content,
          locked: true,
        },
        contexts.length,
      ),
      truncated: truncatedContent.truncated,
      originalLength: truncatedContent.originalLength,
    });
  }

  contexts.push(...supplementalContexts);
  addTruncationWarnings(supplementalContexts, warnings);
}

function finalizeContextPlan(result: PlannedContextResult, options?: TaskContextPlanningOptions): PlannedContextResult {
  const contexts = [...result.contexts];
  const warnings = [...result.warnings];
  appendSupplementalContexts(contexts, warnings, result.effectiveStrategy, options);

  if (contexts.length === 0) {
    return {
      ...result,
      contexts,
      warnings,
    };
  }

  const scoredContexts = scoreContextRelevance({
    task: options?.task ?? '',
    taskType: options?.taskType,
    templateId: options?.templateId,
    constraints: options?.constraints,
    contexts,
  });
  const pruningResult = applyContextBudgetPruning(scoredContexts, options?.budgetPolicy);

  return {
    effectiveStrategy: result.effectiveStrategy,
    contexts: pruningResult.contexts,
    warnings: [...warnings, ...pruningResult.warnings],
    pruningSummary: pruningResult.stageSummaries,
    blockingError: pruningResult.contexts.length > 0 ? undefined : result.blockingError,
  };
}

function planSelectionFirst(
  snapshot: EditorContextSnapshot,
  strategy: TaskTemplateContextStrategy,
  options?: TaskContextPlanningOptions,
): PlannedContextResult {
  const warnings: string[] = [];
  const selectionContent = normalizeContent(snapshot.selectionContent);
  const fileContent = normalizeContent(snapshot.fileContent);
  const contexts: TaskContext[] = [];
  const lockPrimaryContext = options?.lockPrimaryContext ?? false;

  if (selectionContent.length > 0) {
    contexts.push(createTaskContext(snapshot, 'selection', 'primary', selectionContent, strategy.maxChars, lockPrimaryContext, contexts.length));

    if (strategy.includeSupportingContext && fileContent.length > 0 && shouldIncludeSupportingContext(selectionContent, fileContent)) {
      contexts.push(createTaskContext(snapshot, 'file', 'supporting', fileContent, strategy.maxChars, false, contexts.length));
    }
  } else if (fileContent.length > 0) {
    warnings.push('No active selection. Fell back to current file.');
    contexts.push(createTaskContext(snapshot, 'file', 'primary', fileContent, strategy.maxChars, lockPrimaryContext, contexts.length));
  } else {
    return finalizeContextPlan({
      effectiveStrategy: strategy,
      contexts: [],
      warnings,
      blockingError: 'Current editor is empty. Use manual-only mode or add file content first.',
    }, options);
  }

  addTruncationWarnings(contexts, warnings);

  return finalizeContextPlan({
    effectiveStrategy: strategy,
    contexts,
    warnings,
  }, options);
}

function planFileFirst(
  snapshot: EditorContextSnapshot,
  strategy: TaskTemplateContextStrategy,
  options?: TaskContextPlanningOptions,
): PlannedContextResult {
  const warnings: string[] = [];
  const selectionContent = normalizeContent(snapshot.selectionContent);
  const fileContent = normalizeContent(snapshot.fileContent);
  const contexts: TaskContext[] = [];
  const lockPrimaryContext = options?.lockPrimaryContext ?? false;

  if (fileContent.length > 0) {
    contexts.push(createTaskContext(snapshot, 'file', 'primary', fileContent, strategy.maxChars, lockPrimaryContext, contexts.length));

    if (strategy.includeSupportingContext && selectionContent.length > 0 && shouldIncludeSupportingContext(fileContent, selectionContent)) {
      contexts.push(createTaskContext(snapshot, 'selection', 'supporting', selectionContent, strategy.maxChars, false, contexts.length));
    }
  } else if (selectionContent.length > 0) {
    warnings.push('Current file is empty. Fell back to current selection.');
    contexts.push(createTaskContext(snapshot, 'selection', 'primary', selectionContent, strategy.maxChars, lockPrimaryContext, contexts.length));
  } else {
    return finalizeContextPlan({
      effectiveStrategy: strategy,
      contexts: [],
      warnings,
      blockingError: 'Current editor is empty. Use manual-only mode or add file content first.',
    }, options);
  }

  addTruncationWarnings(contexts, warnings);

  return finalizeContextPlan({
    effectiveStrategy: strategy,
    contexts,
    warnings,
  }, options);
}

export function planTaskContexts(
  snapshot: EditorContextSnapshot | undefined,
  strategy: TaskTemplateContextStrategy,
  options?: TaskContextPlanningOptions,
): PlannedContextResult {
  if (strategy.mode === 'manual-only') {
    return finalizeContextPlan({
      effectiveStrategy: strategy,
      contexts: [],
      warnings: ['Manual-only mode selected. No editor context will be attached.'],
    }, options);
  }

  if (!snapshot) {
    return finalizeContextPlan({
      effectiveStrategy: strategy,
      contexts: [],
      warnings: [],
      blockingError: 'Open file in editor before attaching selection or file context.',
    }, options);
  }

  return strategy.mode === 'selection-first' ? planSelectionFirst(snapshot, strategy, options) : planFileFirst(snapshot, strategy, options);
}

export function getContextModeLabel(mode: ContextCaptureMode | TaskTemplateContextStrategyMode): string {
  switch (mode) {
    case 'template-default':
      return 'Template default';
    case 'selection-first':
      return 'Selection first';
    case 'file-first':
      return 'Current file first';
    case 'manual-only':
      return 'Manual only';
  }
}