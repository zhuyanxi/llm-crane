import { buildStructurizerSystemPrompt } from '@llm-crane/prompts';
import {
  StructurizerResultSchema,
  getTaskTemplateDefinition,
  type QualityBar,
  type StructuredTask,
  type StructuredTaskTarget,
  type TaskTemplateDefinition,
  type StructuredTaskType,
  type StructurizerResult,
  type TaskContext,
  type TaskRequest,
} from '@llm-crane/schemas';

const TASK_TYPE_RULES: Array<{ taskType: StructuredTaskType; keywords: string[] }> = [
  { taskType: 'debug', keywords: ['debug', 'fix', 'bug', 'error', 'failing', 'broken', 'issue', 'regression'] },
  { taskType: 'refactor', keywords: ['refactor', 'rewrite', 'cleanup', 'clean up', 'simplify', 'restructure'] },
  { taskType: 'analysis', keywords: ['analyze', 'analysis', 'review', 'inspect', 'explain', 'understand', 'investigate'] },
  { taskType: 'implementation', keywords: ['implement', 'add', 'create', 'build', 'write', 'generate'] },
  { taskType: 'test', keywords: ['test', 'coverage', 'spec', 'assert', 'verify'] },
];

const FILE_PATH_PATTERN = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|yml|yaml)/i;
const SYMBOL_PATTERN = /\b(?:function|class|component|hook|method|module)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function truncate(value: string, length = 96): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))];
}

function getContextPriority(context: TaskContext): TaskContext['priority'] {
  return context.priority ?? 'primary';
}

function summarizeContext(context: TaskContext): string {
  const parts: string[] = [context.source, getContextPriority(context)];
  if (context.languageId) {
    parts.push(context.languageId);
  }
  if (context.uri) {
    parts.push(context.uri);
  }
  if (context.truncated && context.originalLength) {
    parts.push(`truncated=${context.content.length}/${context.originalLength}`);
  }
  return parts.join(' / ');
}

function formatContextMetadataForPrompt(context: TaskContext, index: number): string {
  const parts = [`${index + 1}. source=${context.source}`, `priority=${getContextPriority(context)}`];

  if (context.languageId) {
    parts.push(`language=${context.languageId}`);
  }
  if (context.uri) {
    parts.push(`uri=${context.uri}`);
  }
  if (context.truncated && context.originalLength) {
    parts.push(`truncated=${context.content.length}/${context.originalLength}`);
  }

  return parts.join(' | ');
}

function findContext(taskRequest: TaskRequest, source: TaskContext['source'], priority?: TaskContext['priority']): TaskContext | undefined {
  return taskRequest.contexts.find((context) => context.source === source && (priority === undefined || getContextPriority(context) === priority));
}

function findPreferredContext(taskRequest: TaskRequest, source: TaskContext['source']): TaskContext | undefined {
  return findContext(taskRequest, source, 'primary') ?? findContext(taskRequest, source, 'supporting');
}

function resolveTaskTemplate(taskRequest: TaskRequest): TaskTemplateDefinition | undefined {
  const templateId = taskRequest.taskTemplate?.templateId;
  return templateId ? getTaskTemplateDefinition(templateId) : undefined;
}

function normalizeTemplateValues(taskRequest: TaskRequest): Record<string, string> {
  const entries = Object.entries(taskRequest.taskTemplate?.values ?? {}).map(([fieldId, value]) => [fieldId, normalizeText(value)]);
  return Object.fromEntries(entries.filter(([, value]) => value.length > 0));
}

function detectTaskType(taskRequest: TaskRequest): StructuredTaskType {
  const templateDefinition = resolveTaskTemplate(taskRequest);
  if (templateDefinition) {
    return templateDefinition.taskType;
  }

  if (taskRequest.taskType) {
    const normalizedTaskType = taskRequest.taskType.toLowerCase();
    if (
      normalizedTaskType === 'refactor' ||
      normalizedTaskType === 'debug' ||
      normalizedTaskType === 'analysis' ||
      normalizedTaskType === 'implementation' ||
      normalizedTaskType === 'test'
    ) {
      return normalizedTaskType;
    }
  }

  const text = normalizeText(taskRequest.task).toLowerCase();
  const leadingRule = TASK_TYPE_RULES.find((rule) => rule.keywords.some((keyword) => text === keyword || text.startsWith(`${keyword} `)));
  if (leadingRule) {
    return leadingRule.taskType;
  }

  const matchedRule = TASK_TYPE_RULES.find((rule) => hasKeyword(text, rule.keywords));
  return matchedRule?.taskType ?? 'other';
}

function detectQualityBar(taskRequest: TaskRequest): QualityBar {
  const text = normalizeText(taskRequest.task).toLowerCase();
  if (hasKeyword(text, ['quick', 'quickly', 'fast', 'minimal', 'brief'])) {
    return 'fast';
  }
  if (hasKeyword(text, ['thorough', 'careful', 'deep', 'robust', 'high quality', 'production'])) {
    return 'high';
  }
  return taskRequest.qualityBar;
}

function detectTarget(taskRequest: TaskRequest): StructuredTaskTarget {
  const primarySelectionContext = findContext(taskRequest, 'selection', 'primary');
  if (primarySelectionContext) {
    return {
      kind: 'selection',
      value: truncate(normalizeText(primarySelectionContext.content)),
      uri: primarySelectionContext.uri,
    };
  }

  const primaryWorkspaceContext = findContext(taskRequest, 'workspace', 'primary');
  if (primaryWorkspaceContext) {
    return {
      kind: 'workspace',
      value: primaryWorkspaceContext.uri ?? 'workspace',
      uri: primaryWorkspaceContext.uri,
    };
  }

  const primaryFileContext = findContext(taskRequest, 'file', 'primary');
  if (primaryFileContext) {
    return {
      kind: 'file',
      value: primaryFileContext.uri ?? truncate(normalizeText(primaryFileContext.content)),
      uri: primaryFileContext.uri,
    };
  }

  const supportingSelectionContext = findContext(taskRequest, 'selection', 'supporting');
  if (supportingSelectionContext) {
    return {
      kind: 'selection',
      value: truncate(normalizeText(supportingSelectionContext.content)),
      uri: supportingSelectionContext.uri,
    };
  }

  const supportingWorkspaceContext = findContext(taskRequest, 'workspace', 'supporting');
  if (supportingWorkspaceContext) {
    return {
      kind: 'workspace',
      value: supportingWorkspaceContext.uri ?? 'workspace',
      uri: supportingWorkspaceContext.uri,
    };
  }

  const supportingFileContext = findContext(taskRequest, 'file', 'supporting');
  if (supportingFileContext) {
    return {
      kind: 'file',
      value: supportingFileContext.uri ?? truncate(normalizeText(supportingFileContext.content)),
      uri: supportingFileContext.uri,
    };
  }

  const taskText = normalizeText(taskRequest.task);
  const filePathMatch = taskText.match(FILE_PATH_PATTERN);
  if (filePathMatch) {
    return {
      kind: 'file',
      value: filePathMatch[0],
      uri: filePathMatch[0],
    };
  }

  const symbolMatch = taskText.match(SYMBOL_PATTERN);
  if (symbolMatch) {
    return {
      kind: 'symbol',
      value: symbolMatch[1],
    };
  }

  if (/\b(workspace|repo|repository|project|codebase)\b/i.test(taskText)) {
    return {
      kind: 'workspace',
      value: 'workspace',
    };
  }

  return {
    kind: 'unknown',
    value: 'No explicit target detected',
  };
}

function extractConstraints(taskRequest: TaskRequest): string[] {
  const extractedConstraints = [...taskRequest.constraints, ...(resolveTaskTemplate(taskRequest)?.defaultConstraints ?? [])];
  const taskText = normalizeText(taskRequest.task);
  const patterns: Array<{ pattern: RegExp; prefix: string }> = [
    { pattern: /without\s+([^,.;]+)/gi, prefix: 'Avoid' },
    { pattern: /do not\s+([^,.;]+)/gi, prefix: 'Do not' },
    { pattern: /avoid\s+([^,.;]+)/gi, prefix: 'Avoid' },
    { pattern: /must\s+([^,.;]+)/gi, prefix: 'Must' },
    { pattern: /keep\s+([^,.;]+)/gi, prefix: 'Keep' },
  ];

  for (const { pattern, prefix } of patterns) {
    for (const match of taskText.matchAll(pattern)) {
      if (match[1]) {
        extractedConstraints.push(`${prefix} ${normalizeText(match[1])}`);
      }
    }
  }

  return unique(extractedConstraints);
}

function inferExpectedOutput(taskRequest: TaskRequest, taskType: StructuredTaskType): string[] {
  const templateDefinition = resolveTaskTemplate(taskRequest);
  const templateValues = normalizeTemplateValues(taskRequest);
  const expectedOutput: string[] = [];

  if (templateDefinition?.templateId === 'refactor') {
    expectedOutput.push('Describe safest refactor slice, affected code, and behavior-preservation notes.');
  }

  if (templateDefinition?.templateId === 'debug') {
    expectedOutput.push('Explain root cause, supporting evidence, and smallest next fix or diagnostic step.');
  }

  if (templateDefinition?.templateId === 'architecture-analysis') {
    expectedOutput.push(templateValues.deliverable ?? 'Rank top risks, tradeoffs, and minimal remediation path for requested scope.');
  }

  switch (taskType) {
    case 'refactor':
      expectedOutput.push('Return bounded refactor guidance or code-change summary tied to explicit constraints.');
      break;
    case 'debug':
      expectedOutput.push('Separate observed evidence, likely cause, and unresolved gaps.');
      break;
    case 'analysis':
      expectedOutput.push('Return analysis with ranked risks or tradeoffs instead of generic commentary.');
      break;
    case 'implementation':
      expectedOutput.push('Return concrete implementation slice, affected interfaces, and validation notes.');
      break;
    case 'test':
      expectedOutput.push('Return validation plan, concrete assertions, or test additions bound to target.');
      break;
    default:
      expectedOutput.push('Return bounded plain-text answer with explicit assumptions and next validation step when needed.');
      break;
  }

  return unique(expectedOutput);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function calculateStructurizerConfidence(taskRequest: TaskRequest, structuredTask: StructuredTask): number {
  let score = 0.35;
  const templateDefinition = resolveTaskTemplate(taskRequest);
  const templateValues = normalizeTemplateValues(taskRequest);

  if (templateDefinition) {
    score += 0.15;
  }

  if (templateDefinition && templateDefinition.inputFields.every((field) => !field.required || Boolean(templateValues[field.fieldId]))) {
    score += 0.15;
  }

  if (structuredTask.target.kind !== 'unknown') {
    score += 0.15;
  }

  if (taskRequest.contexts.some((context) => context.priority === 'primary')) {
    score += 0.1;
  }

  if (taskRequest.contexts.some((context) => context.priority === 'supporting')) {
    score += 0.03;
  }

  if (taskRequest.contexts.length > 0) {
    score += 0.05;
  }

  if (taskRequest.contexts.some((context) => context.truncated)) {
    score -= 0.05;
  }

  score -= Math.min(structuredTask.openQuestions.length, 3) * 0.08;
  score -= structuredTask.uncertaintyReasons.length * 0.05;

  return Number(clamp(score, 0.05, 0.98).toFixed(2));
}

function inferOpenQuestions(
  taskRequest: TaskRequest,
  taskType: StructuredTaskType,
  target: StructuredTaskTarget,
  constraints: string[],
): string[] {
  const openQuestions: string[] = [];
  const taskText = normalizeText(taskRequest.task).toLowerCase();
  const templateDefinition = resolveTaskTemplate(taskRequest);
  const templateValues = normalizeTemplateValues(taskRequest);

  if (taskRequest.taskTemplate && !templateDefinition) {
    openQuestions.push(`Which task template should replace unknown template id "${taskRequest.taskTemplate.templateId}"?`);
  }

  if (templateDefinition) {
    for (const field of templateDefinition.inputFields) {
      if (field.required && !templateValues[field.fieldId]) {
        openQuestions.push(`What template input is missing for ${field.label}?`);
      }
    }
  }

  if (target.kind === 'unknown') {
    openQuestions.push('What code artifact should this task apply to?');
  }

  if (taskRequest.contexts.length === 0 && target.kind !== 'workspace') {
    openQuestions.push('Should structurizer rely on current selection, current file, or broader workspace context?');
  }

  if (taskType === 'debug' && !hasKeyword(taskText, ['error', 'exception', 'fail', 'bug', 'stack', 'repro'])) {
    openQuestions.push('What failure message, symptom, or reproduction step should guide debugging?');
  }

  if (taskType === 'refactor' && !hasKeyword(taskText, ['duplication', 'readability', 'performance', 'maintainability', 'api'])) {
    openQuestions.push('What is primary refactor goal: readability, performance, decomposition, or API cleanup?');
  }

  if (taskType === 'analysis' && !hasKeyword(taskText, ['architecture', 'risk', 'performance', 'security', 'cost', 'maintainability'])) {
    openQuestions.push('What analysis lens matters most: architecture, bug risk, performance, or maintainability?');
  }

  if (constraints.length === 0 && hasKeyword(taskText, ['safe', 'careful'])) {
    openQuestions.push('Which safety constraints are mandatory for this task?');
  }

  return unique(openQuestions);
}

function inferUncertaintyReasons(taskType: StructuredTaskType, target: StructuredTaskTarget, openQuestions: string[]): string[] {
  const uncertaintyReasons: string[] = [];

  if (taskType === 'other') {
    uncertaintyReasons.push('Unable to confidently classify task type from request text.');
  }

  if (target.kind === 'unknown') {
    uncertaintyReasons.push('No explicit file, symbol, selection, or workspace target was identified.');
  }

  if (openQuestions.length > 0) {
    uncertaintyReasons.push('Important task details are still missing and need clarification.');
  }

  return unique(uncertaintyReasons);
}

function inferWarnings(taskRequest: TaskRequest, openQuestions: string[]): string[] {
  const warnings: string[] = [];
  const templateDefinition = resolveTaskTemplate(taskRequest);

  if (taskRequest.contexts.length === 0) {
    warnings.push('Structurizer relied only on manual task text.');
  }

  if (taskRequest.contexts.some((context) => context.truncated)) {
    warnings.push('Some attached context was truncated before Structurizer stage.');
  }

  if (taskRequest.taskTemplate && !templateDefinition) {
    warnings.push(`Unknown task template id ${taskRequest.taskTemplate.templateId}; structurizer fell back to free-text heuristics.`);
  }

  if (openQuestions.length > 0) {
    warnings.push('Open questions remain before downstream routing can be fully confident.');
  }

  return unique(warnings);
}

function buildStructuredTask(taskRequest: TaskRequest): StructuredTask {
  const templateDefinition = resolveTaskTemplate(taskRequest);
  const templateValues = normalizeTemplateValues(taskRequest);
  const taskType = detectTaskType(taskRequest);
  const target = detectTarget(taskRequest);
  const constraints = extractConstraints(taskRequest);
  const expectedOutput = inferExpectedOutput(taskRequest, taskType);
  const openQuestions = inferOpenQuestions(taskRequest, taskType, target, constraints);
  const uncertaintyReasons = inferUncertaintyReasons(taskType, target, openQuestions);

  return {
    originalTask: normalizeText(taskRequest.task),
    taskType,
    goal: normalizeText(taskRequest.task),
    target,
    template: templateDefinition
      ? {
          templateId: templateDefinition.templateId,
          label: templateDefinition.label,
          taskType: templateDefinition.taskType,
          defaultConstraints: templateDefinition.defaultConstraints,
          values: templateValues,
        }
      : undefined,
    qualityBar: detectQualityBar(taskRequest),
    constraints,
    expectedOutput,
    openQuestions,
    uncertaintyReasons,
    contextSummary: taskRequest.contexts.map(summarizeContext),
  };
}

export function buildStructurizerPrompt(taskRequest: TaskRequest): string {
  const templateDefinition = resolveTaskTemplate(taskRequest);
  const taskType = detectTaskType(taskRequest);
  const systemPrompt = buildStructurizerSystemPrompt(templateDefinition?.templateId);
  const contextMetadataLines = taskRequest.contexts.length > 0
    ? taskRequest.contexts.map(formatContextMetadataForPrompt)
    : ['none'];

  return [
    systemPrompt,
    `Task: ${normalizeText(taskRequest.task)}`,
    templateDefinition
      ? `Task template: ${templateDefinition.templateId} (${templateDefinition.label}) ${JSON.stringify(normalizeTemplateValues(taskRequest))}`
      : 'Task template: none',
    templateDefinition
      ? `Template context strategy: ${templateDefinition.contextStrategy.mode} / supporting=${templateDefinition.contextStrategy.includeSupportingContext} / maxChars=${templateDefinition.contextStrategy.maxChars}`
      : 'Template context strategy: none',
    `Context count: ${taskRequest.contexts.length}`,
    'Context metadata:',
    ...contextMetadataLines,
    `Inferred task type: ${taskType}`,
    `Expected output hints: ${inferExpectedOutput(taskRequest, taskType).join(' | ') || 'none'}`,
    `Known constraints: ${extractConstraints(taskRequest).join(' | ') || 'none'}`,
  ].join('\n');
}

export function createFallbackStructurizerResult(taskRequest: TaskRequest, reason: string): StructurizerResult {
  const structuredTask = buildStructuredTask(taskRequest);
  const uncertaintyReasons = unique([...structuredTask.uncertaintyReasons, reason]);
  const confidence = calculateStructurizerConfidence(taskRequest, {
    ...structuredTask,
    uncertaintyReasons,
  });

  return StructurizerResultSchema.parse({
    status: 'fallback',
    confidence,
    structuredTask: {
      ...structuredTask,
      uncertaintyReasons,
      openQuestions: unique([...structuredTask.openQuestions, 'Clarify missing information before trusting downstream routing.']),
    },
    fallbackReason: reason,
    warnings: unique([reason, ...inferWarnings(taskRequest, structuredTask.openQuestions)]),
  });
}

export function parseStructurizerOutput(candidate: unknown, taskRequest: TaskRequest): StructurizerResult {
  try {
    const parsed = StructurizerResultSchema.parse(candidate);
    const withFallbackReason = parsed.status === 'fallback' && !parsed.fallbackReason
      ? StructurizerResultSchema.parse({
        ...parsed,
        fallbackReason: 'Structurizer requested conservative fallback.',
      })
      : parsed;

    return StructurizerResultSchema.parse({
      ...withFallbackReason,
      confidence: withFallbackReason.confidence ?? calculateStructurizerConfidence(taskRequest, withFallbackReason.structuredTask),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown structurizer parse error.';
    return createFallbackStructurizerResult(taskRequest, `Structurizer output invalid: ${reason}`);
  }
}

function inferStructurizerCandidate(taskRequest: TaskRequest): unknown {
  const structuredTask = buildStructuredTask(taskRequest);
  const warnings = inferWarnings(taskRequest, structuredTask.openQuestions);
  const status = structuredTask.uncertaintyReasons.length > 0 ? 'fallback' : 'structured';
  const confidence = calculateStructurizerConfidence(taskRequest, structuredTask);

  return {
    status,
    confidence,
    structuredTask,
    fallbackReason:
      status === 'fallback' ? structuredTask.uncertaintyReasons.join(' ') || 'Structurizer chose conservative fallback.' : undefined,
    warnings,
  };
}

export function structurizeTaskRequest(taskRequest: TaskRequest): StructurizerResult {
  return parseStructurizerOutput(inferStructurizerCandidate(taskRequest), taskRequest);
}