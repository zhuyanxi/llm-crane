import type {
  TaskContext,
  TaskTemplateContextStrategy,
  TaskTemplateContextStrategyMode,
} from '@llm-crane/schemas';

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
  blockingError?: string;
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
): TaskContext {
  const truncatedContent = truncateContent(rawContent, maxChars);

  return {
    source,
    priority,
    uri: snapshot.uri,
    languageId: snapshot.languageId,
    content: truncatedContent.content,
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

function planSelectionFirst(snapshot: EditorContextSnapshot, strategy: TaskTemplateContextStrategy): PlannedContextResult {
  const warnings: string[] = [];
  const selectionContent = normalizeContent(snapshot.selectionContent);
  const fileContent = normalizeContent(snapshot.fileContent);
  const contexts: TaskContext[] = [];

  if (selectionContent.length > 0) {
    contexts.push(createTaskContext(snapshot, 'selection', 'primary', selectionContent, strategy.maxChars));

    if (strategy.includeSupportingContext && fileContent.length > 0 && shouldIncludeSupportingContext(selectionContent, fileContent)) {
      contexts.push(createTaskContext(snapshot, 'file', 'supporting', fileContent, strategy.maxChars));
    }
  } else if (fileContent.length > 0) {
    warnings.push('No active selection. Fell back to current file.');
    contexts.push(createTaskContext(snapshot, 'file', 'primary', fileContent, strategy.maxChars));
  } else {
    return {
      effectiveStrategy: strategy,
      contexts: [],
      warnings,
      blockingError: 'Current editor is empty. Use manual-only mode or add file content first.',
    };
  }

  addTruncationWarnings(contexts, warnings);

  return {
    effectiveStrategy: strategy,
    contexts,
    warnings,
  };
}

function planFileFirst(snapshot: EditorContextSnapshot, strategy: TaskTemplateContextStrategy): PlannedContextResult {
  const warnings: string[] = [];
  const selectionContent = normalizeContent(snapshot.selectionContent);
  const fileContent = normalizeContent(snapshot.fileContent);
  const contexts: TaskContext[] = [];

  if (fileContent.length > 0) {
    contexts.push(createTaskContext(snapshot, 'file', 'primary', fileContent, strategy.maxChars));

    if (strategy.includeSupportingContext && selectionContent.length > 0 && shouldIncludeSupportingContext(fileContent, selectionContent)) {
      contexts.push(createTaskContext(snapshot, 'selection', 'supporting', selectionContent, strategy.maxChars));
    }
  } else if (selectionContent.length > 0) {
    warnings.push('Current file is empty. Fell back to current selection.');
    contexts.push(createTaskContext(snapshot, 'selection', 'primary', selectionContent, strategy.maxChars));
  } else {
    return {
      effectiveStrategy: strategy,
      contexts: [],
      warnings,
      blockingError: 'Current editor is empty. Use manual-only mode or add file content first.',
    };
  }

  addTruncationWarnings(contexts, warnings);

  return {
    effectiveStrategy: strategy,
    contexts,
    warnings,
  };
}

export function planTaskContexts(
  snapshot: EditorContextSnapshot | undefined,
  strategy: TaskTemplateContextStrategy,
): PlannedContextResult {
  if (strategy.mode === 'manual-only') {
    return {
      effectiveStrategy: strategy,
      contexts: [],
      warnings: ['Manual-only mode selected. No editor context will be attached.'],
    };
  }

  if (!snapshot) {
    return {
      effectiveStrategy: strategy,
      contexts: [],
      warnings: [],
      blockingError: 'Open file in editor before attaching selection or file context.',
    };
  }

  return strategy.mode === 'selection-first' ? planSelectionFirst(snapshot, strategy) : planFileFirst(snapshot, strategy);
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