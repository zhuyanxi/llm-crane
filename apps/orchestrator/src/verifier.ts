import {
  VerificationResultSchema,
  type VerificationFinding,
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
const VERIFIER_COMPOSITE_ID = 'composite-verifier-v1';
const VERIFIER_MAX_OUTPUT_TOKENS = 900;
const VERIFIER_TIMEOUT_MS = 15_000;

const SUGGESTED_ACTION_PRIORITY: Record<VerificationResult['suggestedAction'], number> = {
  proceed: 0,
  'manual-confirm': 1,
  retry: 2,
  'upgrade-model': 3,
};

type HardOutputRule = 'json' | 'numbered-list' | 'bullet-list';

type VerifierFailureOptions = {
  suggestedAction?: 'retry' | 'manual-confirm';
  verifierId?: string;
  verifierKind?: VerificationKind;
  codePrefix?: string;
};

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

export interface RuleVerifier {
  readonly verifierId: string;
  readonly verifierKind: 'rule';
  verify(context: VerifierContext): Promise<VerificationResult | undefined> | VerificationResult | undefined;
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

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))];
}

function addFindingSource(result: VerificationResult): VerificationResult {
  return {
    ...result,
    findings: result.findings.map((finding) => ({
      ...finding,
      verifierId: finding.verifierId ?? result.verifierId,
      verifierKind: finding.verifierKind ?? (result.verifierKind === 'composite' ? undefined : result.verifierKind),
    })),
  };
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

  return createVerificationResult(addFindingSource({
    ...result,
    verifierId: result.verifierId || VERIFIER_MODEL_ID,
    verifierKind: result.verifierKind || 'model',
    suggestedAction,
  }));
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

export function createVerifierFailureResult(
  summary: string,
  reasons: string[],
  options: VerifierFailureOptions = {},
): VerificationResult {
  return createVerificationResult({
    verifierId: options.verifierId ?? VERIFIER_MODEL_ID,
    verifierKind: options.verifierKind ?? 'model',
    verdict: 'warning',
    summary,
    reasons,
    suggestedAction: options.suggestedAction ?? 'retry',
    findings: reasons.map((reason, index) => ({
      code: `${options.codePrefix ?? 'verifier_failure'}_${index + 1}`,
      summary: 'Verifier unavailable',
      detail: reason,
      severity: 'warning',
    })),
  });
}

function createPassVerificationResult(
  verifierId: string,
  verifierKind: Extract<VerificationKind, 'model' | 'rule'>,
  summary: string,
  reasons: string[] = [],
): VerificationResult {
  return createVerificationResult({
    verifierId,
    verifierKind,
    verdict: 'pass',
    summary,
    reasons,
    suggestedAction: 'proceed',
    findings: [],
  });
}

function createRuleFailureResult(
  verifierId: string,
  summary: string,
  reason: string,
  code: string,
  detail: string,
  suggestedAction: 'retry' | 'manual-confirm' = 'retry',
): VerificationResult {
  return createVerificationResult({
    verifierId,
    verifierKind: 'rule',
    verdict: 'fail',
    summary,
    reasons: [reason],
    suggestedAction,
    findings: [
      {
        code,
        summary,
        detail,
        severity: 'fail',
      },
    ],
  });
}

function collectRuleTexts(context: VerifierContext): string[] {
  return [
    context.taskRequest.task,
    ...context.taskRequest.constraints,
    ...context.structurizerResult.structuredTask.constraints,
    ...context.structurizerResult.structuredTask.expectedOutput,
    ...(context.plannerResult?.downstreamHints.verifierChecks ?? []),
  ];
}

function detectHardOutputRules(texts: string[]): HardOutputRule[] {
  const rules: HardOutputRule[] = [];
  const hasJsonRule = texts.some((text) => /(?:strict|valid|parseable)?\s*json\b/i.test(text));
  const hasNumberedListRule = texts.some((text) => /\b(numbered|ordered)\s+list\b|\buse\s+numbers\b/i.test(text));
  const hasBulletListRule = texts.some((text) => /\b(bullet|bulleted)\s+list\b|\bmarkdown\s+bullets\b/i.test(text));

  if (hasJsonRule) {
    rules.push('json');
  }
  if (hasNumberedListRule) {
    rules.push('numbered-list');
  }
  if (hasBulletListRule) {
    rules.push('bullet-list');
  }

  return rules;
}

function hasNumberedList(output: string): boolean {
  return output.split(/\r?\n/).some((line) => /^\s*\d+\.\s+\S+/.test(line));
}

function hasBulletList(output: string): boolean {
  return output.split(/\r?\n/).some((line) => /^\s*[-*]\s+\S+/.test(line));
}

export function createJsonSchemaRuleVerifier(): RuleVerifier {
  return {
    verifierId: 'rule-json-schema-v1',
    verifierKind: 'rule',
    verify(context: VerifierContext): VerificationResult | undefined {
      const rules = detectHardOutputRules(collectRuleTexts(context));
      if (!rules.includes('json')) {
        return undefined;
      }

      const output = context.output ?? context.providerResult?.outputText ?? '';
      try {
        extractJsonCandidate(output);
        return createPassVerificationResult(
          'rule-json-schema-v1',
          'rule',
          'JSON schema rule passed.',
          ['Output satisfied explicit JSON formatting rule.'],
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Output was not valid JSON.';
        return createRuleFailureResult(
          'rule-json-schema-v1',
          'JSON schema rule failed.',
          'Output did not satisfy explicit JSON output requirement.',
          'schema_invalid_json',
          reason,
        );
      }
    },
  };
}

export function createListFormatRuleVerifier(): RuleVerifier {
  return {
    verifierId: 'rule-output-format-v1',
    verifierKind: 'rule',
    verify(context: VerifierContext): VerificationResult | undefined {
      const rules = detectHardOutputRules(collectRuleTexts(context));
      const output = context.output ?? context.providerResult?.outputText ?? '';

      if (rules.includes('numbered-list') && !hasNumberedList(output)) {
        return createRuleFailureResult(
          'rule-output-format-v1',
          'Numbered list rule failed.',
          'Output did not satisfy explicit numbered list requirement.',
          'format_numbered_list_missing',
          'Expected at least one line matching `1. item` style output.',
        );
      }

      if (rules.includes('bullet-list') && !hasBulletList(output)) {
        return createRuleFailureResult(
          'rule-output-format-v1',
          'Bullet list rule failed.',
          'Output did not satisfy explicit bullet list requirement.',
          'format_bullet_list_missing',
          'Expected at least one line matching `- item` or `* item` style output.',
        );
      }

      if (!rules.includes('numbered-list') && !rules.includes('bullet-list')) {
        return undefined;
      }

      return createPassVerificationResult(
        'rule-output-format-v1',
        'rule',
        'Output format rule passed.',
        ['Output satisfied explicit list-format requirement.'],
      );
    },
  };
}

export function buildDefaultRuleVerifiers(): RuleVerifier[] {
  return [createJsonSchemaRuleVerifier(), createListFormatRuleVerifier()];
}

export async function runRuleVerifiers(
  context: VerifierContext,
  ruleVerifiers: RuleVerifier[] = buildDefaultRuleVerifiers(),
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const ruleVerifier of ruleVerifiers) {
    try {
      const result = await ruleVerifier.verify(context);
      if (result) {
        results.push(normalizeVerificationResult(result));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown rule verifier failure.';
      results.push(
        createVerifierFailureResult(
          `Rule verifier ${ruleVerifier.verifierId} failed safely.`,
          [`Rule verifier crashed: ${reason}`],
          {
            verifierId: ruleVerifier.verifierId,
            verifierKind: 'rule',
            suggestedAction: 'manual-confirm',
            codePrefix: 'rule_verifier_failure',
          },
        ),
      );
    }
  }

  return results;
}

function chooseSuggestedAction(results: VerificationResult[]): VerificationResult['suggestedAction'] {
  return [...results].sort(
    (left, right) => SUGGESTED_ACTION_PRIORITY[right.suggestedAction] - SUGGESTED_ACTION_PRIORITY[left.suggestedAction],
  )[0]?.suggestedAction ?? 'proceed';
}

function chooseMergedVerdict(results: VerificationResult[]): VerificationResult['verdict'] {
  if (results.some((result) => result.verdict === 'fail')) {
    return 'fail';
  }

  if (results.some((result) => result.verdict === 'warning')) {
    return 'warning';
  }

  return 'pass';
}

function collectMergedFindings(results: VerificationResult[]): VerificationFinding[] {
  return results.flatMap((result) => result.findings.map((finding) => ({
    ...finding,
    verifierId: finding.verifierId ?? result.verifierId,
    verifierKind: finding.verifierKind ?? (result.verifierKind === 'composite' ? undefined : result.verifierKind),
  })));
}

export function mergeVerificationResults(results: VerificationResult[]): VerificationResult {
  const normalizedResults = results.map((result) => normalizeVerificationResult(result));
  if (normalizedResults.length === 0) {
    return createVerifierFailureResult(
      'Verifier produced no result.',
      ['No model or rule verifier returned a usable result.'],
      {
        verifierId: VERIFIER_COMPOSITE_ID,
        verifierKind: 'composite',
        suggestedAction: 'manual-confirm',
        codePrefix: 'composite_verifier_failure',
      },
    );
  }

  if (normalizedResults.length === 1) {
    return normalizedResults[0];
  }

  return createVerificationResult({
    verifierId: VERIFIER_COMPOSITE_ID,
    verifierKind: 'composite',
    verdict: chooseMergedVerdict(normalizedResults),
    summary: `Combined verifier checks: ${normalizedResults.map((result) => `${result.verifierId}=${result.verdict}`).join(' · ')}`,
    reasons: unique(normalizedResults.flatMap((result) => result.reasons.map((reason) => `${result.verifierId}: ${reason}`))),
    suggestedAction: chooseSuggestedAction(normalizedResults),
    findings: collectMergedFindings(normalizedResults),
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

    return createVerifierFailureResult('Model verifier unavailable.', [reason], {
      suggestedAction: 'retry',
    });
  }
}