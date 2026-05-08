import {
  VerificationResultSchema,
  type PlannerResult,
  type ProviderExecutionResult,
  type ReasonerResult,
  type RouteDecision,
  type StructurizerResult,
  type TaskRequest,
  type VerificationKind,
  type VerificationResult,
} from '@llm-crane/schemas';
import { VERIFIER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import { ProviderInvocationError, type ProviderInvocationRequest } from '@llm-crane/providers';

type VerifierProviderInvoker = {
  invoke(request: ProviderInvocationRequest): Promise<{
    providerId: string;
    modelId: string;
    outputText: string;
  }>;
};

const VERIFIER_MODEL_ID = 'model-consistency-v1';
const VERIFIER_MAX_OUTPUT_TOKENS = 900;
const VERIFIER_TIMEOUT_MS = 15_000;

export type VerifierContext = {
  taskRequest: TaskRequest;
  structurizerResult: StructurizerResult;
  routeDecision: RouteDecision;
  plannerResult?: PlannerResult;
  reasonerResult?: ReasonerResult;
  providerResult?: ProviderExecutionResult;
  output?: string;
};

export interface Verifier {
  readonly verifierId: string;
  readonly verifierKind: VerificationKind;
  verify(context: VerifierContext): Promise<VerificationResult> | VerificationResult;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength = 4000): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function extractJsonCandidate(rawOutput: string): unknown {
  const trimmed = rawOutput.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1].trim());
  }

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
  }

  throw new Error('Verifier output did not contain parseable JSON object.');
}

function buildPlannerVerifierChecks(plannerResult?: PlannerResult): string {
  if (!plannerResult || plannerResult.downstreamHints.verifierChecks.length === 0) {
    return 'No extra verifier checks from planner.';
  }

  return plannerResult.downstreamHints.verifierChecks.map((check, index) => `${index + 1}. ${check}`).join('\n');
}

function buildPlannerSummary(plannerResult?: PlannerResult): string {
  if (!plannerResult) {
    return 'No planner result.';
  }

  return JSON.stringify({
    status: plannerResult.status,
    summary: plannerResult.summary,
    steps: plannerResult.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      objective: step.objective,
      acceptance: step.acceptance,
    })),
    decisionPoints: plannerResult.decisionPoints,
    warnings: plannerResult.warnings,
  }, null, 2);
}

function buildReasonerSummary(reasonerResult?: ReasonerResult): string {
  if (!reasonerResult) {
    return 'No reasoner result.';
  }

  return JSON.stringify({
    status: reasonerResult.status,
    decisionSource: reasonerResult.decisionSource,
    summary: reasonerResult.summary,
    escalationReason: reasonerResult.escalationReason,
    earlyExitReason: reasonerResult.earlyExitReason,
    keyEvidence: reasonerResult.keyEvidence,
    warnings: reasonerResult.warnings,
  }, null, 2);
}

function normalizeVerificationResult(result: VerificationResult): VerificationResult {
  const suggestedAction = result.verdict === 'pass'
    ? 'proceed'
    : result.verdict === 'fail'
      ? result.suggestedAction === 'proceed' ? 'retry' : result.suggestedAction
      : result.suggestedAction === 'proceed' ? 'manual-confirm' : result.suggestedAction;

  return createVerificationResult({
    ...result,
    verifierId: result.verifierId || VERIFIER_MODEL_ID,
    verifierKind: result.verifierKind || 'model',
    suggestedAction,
  });
}

export function createVerificationResult(result: VerificationResult): VerificationResult {
  return VerificationResultSchema.parse(result);
}

export function createDeferredVerificationResult(
  summary: string,
  reasons: string[],
  verifierKind: VerificationKind = 'model',
): VerificationResult {
  return VerificationResultSchema.parse({
    verifierId: 'deferred-verifier',
    verifierKind,
    verdict: 'warning',
    summary,
    reasons,
    suggestedAction: 'manual-confirm',
    findings: reasons.map((reason, index) => ({
      code: `deferred_${verifierKind}_${index + 1}`,
      summary: 'Verifier deferred',
      detail: reason,
      severity: 'warning',
    })),
  });
}

export function createVerifierFailureResult(summary: string, reasons: string[], suggestedAction: 'retry' | 'manual-confirm' = 'retry'): VerificationResult {
  return createVerificationResult({
    verifierId: VERIFIER_MODEL_ID,
    verifierKind: 'model',
    verdict: 'warning',
    summary,
    reasons,
    suggestedAction,
    findings: reasons.map((reason, index) => ({
      code: `verifier_failure_${index + 1}`,
      summary: 'Verifier unavailable',
      detail: reason,
      severity: 'warning',
    })),
  });
}

export function buildVerifierUserPrompt(context: VerifierContext): string {
  return [
    `Original task:\n${context.taskRequest.task}`,
    `Structured task:\n${JSON.stringify(context.structurizerResult.structuredTask, null, 2)}`,
    `Route decision:\n${JSON.stringify(context.routeDecision, null, 2)}`,
    `Constraints:\n${context.taskRequest.constraints.length > 0 ? context.taskRequest.constraints.map((constraint, index) => `${index + 1}. ${constraint}`).join('\n') : 'No explicit constraints.'}`,
    `Expected output:\n${context.structurizerResult.structuredTask.expectedOutput.length > 0 ? context.structurizerResult.structuredTask.expectedOutput.map((entry, index) => `${index + 1}. ${entry}`).join('\n') : 'No explicit output shape.'}`,
    `Planner result:\n${buildPlannerSummary(context.plannerResult)}`,
    `Planner verifier checks:\n${buildPlannerVerifierChecks(context.plannerResult)}`,
    `Reasoner result:\n${buildReasonerSummary(context.reasonerResult)}`,
    `Executor output to verify:\n${truncate(context.output ?? context.providerResult?.outputText ?? '', 12_000)}`,
    [
      'Check consistency only against provided task, constraints, expected output, planner steps, and verifier checks.',
      'Use findings codes like constraint_missing, format_mismatch, reasoning_gap, or other concrete code when needed.',
      'Return strict JSON only. No markdown. No hidden reasoning.',
    ].join(' '),
  ].join('\n\n');
}

export function parseVerificationOutput(rawOutput: string): VerificationResult {
  const candidate = extractJsonCandidate(rawOutput);
  return normalizeVerificationResult(createVerificationResult(candidate as VerificationResult));
}

export async function verifyTaskWithModel(
  providerInvoker: VerifierProviderInvoker,
  modelId: string,
  context: VerifierContext,
): Promise<VerificationResult> {
  try {
    const result = await providerInvoker.invoke({
      modelId,
      prompt: buildVerifierUserPrompt(context),
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      temperature: 0,
      maxOutputTokens: VERIFIER_MAX_OUTPUT_TOKENS,
      timeoutMs: VERIFIER_TIMEOUT_MS,
      metadata: {
        verifierId: VERIFIER_MODEL_ID,
        route: context.routeDecision.route,
        taskType: context.structurizerResult.structuredTask.taskType,
      },
    });

    return parseVerificationOutput(result.outputText);
  } catch (error) {
    const reason = error instanceof ProviderInvocationError
      ? `Verifier provider error: ${error.message}`
      : error instanceof Error
        ? `Verifier execution failed: ${error.message}`
        : 'Verifier execution failed with unknown error.';

    return createVerifierFailureResult('Model verifier unavailable.', [reason], 'retry');
  }
}