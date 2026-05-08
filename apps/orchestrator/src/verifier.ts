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