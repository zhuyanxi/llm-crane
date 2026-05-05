import { STRUCTURIZER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import {
  StructurizerResultSchema,
  type QualityBar,
  type StructuredTask,
  type StructuredTaskTarget,
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

function summarizeContext(context: TaskContext): string {
  const parts: string[] = [context.source];
  if (context.languageId) {
    parts.push(context.languageId);
  }
  if (context.uri) {
    parts.push(context.uri);
  }
  return parts.join(' / ');
}

function detectTaskType(taskRequest: TaskRequest): StructuredTaskType {
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
  const selectionContext = taskRequest.contexts.find((context) => context.source === 'selection');
  if (selectionContext) {
    return {
      kind: 'selection',
      value: truncate(normalizeText(selectionContext.content)),
      uri: selectionContext.uri,
    };
  }

  const workspaceContext = taskRequest.contexts.find((context) => context.source === 'workspace');
  if (workspaceContext) {
    return {
      kind: 'workspace',
      value: workspaceContext.uri ?? 'workspace',
      uri: workspaceContext.uri,
    };
  }

  const fileContext = taskRequest.contexts.find((context) => context.source === 'file');
  if (fileContext) {
    return {
      kind: 'file',
      value: fileContext.uri ?? truncate(normalizeText(fileContext.content)),
      uri: fileContext.uri,
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
  const extractedConstraints = [...taskRequest.constraints];
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

function inferOpenQuestions(
  taskRequest: TaskRequest,
  taskType: StructuredTaskType,
  target: StructuredTaskTarget,
  constraints: string[],
): string[] {
  const openQuestions: string[] = [];
  const taskText = normalizeText(taskRequest.task).toLowerCase();

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

  if (taskRequest.contexts.length === 0) {
    warnings.push('Structurizer relied only on manual task text.');
  }

  if (openQuestions.length > 0) {
    warnings.push('Open questions remain before downstream routing can be fully confident.');
  }

  return unique(warnings);
}

function buildStructuredTask(taskRequest: TaskRequest): StructuredTask {
  const taskType = detectTaskType(taskRequest);
  const target = detectTarget(taskRequest);
  const constraints = extractConstraints(taskRequest);
  const openQuestions = inferOpenQuestions(taskRequest, taskType, target, constraints);
  const uncertaintyReasons = inferUncertaintyReasons(taskType, target, openQuestions);

  return {
    originalTask: normalizeText(taskRequest.task),
    taskType,
    goal: normalizeText(taskRequest.task),
    target,
    qualityBar: detectQualityBar(taskRequest),
    constraints,
    openQuestions,
    uncertaintyReasons,
    contextSummary: taskRequest.contexts.map(summarizeContext),
  };
}

export function buildStructurizerPrompt(taskRequest: TaskRequest): string {
  return [
    STRUCTURIZER_SYSTEM_PROMPT,
    `Task: ${normalizeText(taskRequest.task)}`,
    `Context count: ${taskRequest.contexts.length}`,
    `Known constraints: ${extractConstraints(taskRequest).join(' | ') || 'none'}`,
  ].join('\n');
}

export function createFallbackStructurizerResult(taskRequest: TaskRequest, reason: string): StructurizerResult {
  const structuredTask = buildStructuredTask(taskRequest);
  const uncertaintyReasons = unique([...structuredTask.uncertaintyReasons, reason]);

  return StructurizerResultSchema.parse({
    status: 'fallback',
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
    if (parsed.status === 'fallback' && !parsed.fallbackReason) {
      return StructurizerResultSchema.parse({
        ...parsed,
        fallbackReason: 'Structurizer requested conservative fallback.',
      });
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown structurizer parse error.';
    return createFallbackStructurizerResult(taskRequest, `Structurizer output invalid: ${reason}`);
  }
}

function inferStructurizerCandidate(taskRequest: TaskRequest): unknown {
  const structuredTask = buildStructuredTask(taskRequest);
  const warnings = inferWarnings(taskRequest, structuredTask.openQuestions);
  const status = structuredTask.uncertaintyReasons.length > 0 ? 'fallback' : 'structured';

  return {
    status,
    structuredTask,
    fallbackReason:
      status === 'fallback' ? structuredTask.uncertaintyReasons.join(' ') || 'Structurizer chose conservative fallback.' : undefined,
    warnings,
  };
}

export function structurizeTaskRequest(taskRequest: TaskRequest): StructurizerResult {
  return parseStructurizerOutput(inferStructurizerCandidate(taskRequest), taskRequest);
}