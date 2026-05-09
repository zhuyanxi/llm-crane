import { describe, expect, it, vi } from 'vitest';
import type { PlannerResult, ProviderExecutionResult, ReasonerResult, RouteDecision, StructurizerResult, TaskRequest } from '@llm-crane/schemas';
import { buildVerifierUserPrompt, createDeferredVerificationResult, createVerificationResult, createListFormatRuleVerifier, mergeVerificationResults, parseVerificationOutput, runRuleVerifiers, verifyTaskWithModel } from '../src/verifier';

const baseTaskRequest: TaskRequest = {
  task: 'Analyze workspace risk and keep public API stable.',
  qualityBar: 'high',
  constraints: ['Keep public API stable', 'Return ranked risks'],
  contexts: [
    {
      source: 'workspace',
      uri: '/workspace',
      content: 'workspace snapshot',
    },
  ],
};

const baseStructurizerResult: StructurizerResult = {
  status: 'structured',
  confidence: 0.8,
  structuredTask: {
    originalTask: baseTaskRequest.task,
    taskType: 'analysis',
    goal: baseTaskRequest.task,
    target: {
      kind: 'workspace',
      value: '/workspace',
      uri: '/workspace',
    },
    qualityBar: 'high',
    constraints: baseTaskRequest.constraints,
    expectedOutput: ['Rank top risks before proposing remediation.'],
    openQuestions: [],
    uncertaintyReasons: [],
    contextSummary: ['workspace / /workspace'],
  },
  warnings: [],
};

const baseRouteDecision: RouteDecision = {
  status: 'routed',
  route: 'complex',
  reason: 'Workspace analysis needs broader reasoning.',
  confidence: 0.84,
  complexityScore: 8,
  scoreBreakdown: [],
  strategy: 'rules-v1',
};

const basePlannerResult: PlannerResult = {
  status: 'planned',
  summary: 'Execution plan for workspace analysis.',
  steps: [
    {
      stepId: 'inspect-context',
      title: 'Inspect context',
      objective: 'Review attached context and constraints.',
      acceptance: 'Response reflects constraints.',
    },
  ],
  decisionPoints: [],
  openQuestions: [],
  downstreamHints: {
    reasonerFocus: ['Compare top risks and rank by impact.'],
    verifierChecks: ['Check public API stability.'],
  },
  warnings: [],
};

const baseReasonerResult: ReasonerResult = {
  status: 'reasoned',
  needReasoning: true,
  decisionSource: 'router+planner',
  escalationReason: 'Workspace-wide scope requires synthesis.',
  summary: 'Escalate reasoning for workspace analysis.',
  keyEvidence: ['Task type: analysis', 'Target: current workspace'],
  warnings: [],
};

const baseProviderResult: ProviderExecutionResult = {
  status: 'completed',
  providerId: 'anthropic',
  modelId: 'claude-3-5-sonnet-latest',
  outputText: '1. Risk A\n2. Risk B\nValidation: keep API stable.',
  latencyMs: 180,
};

describe('verifier contract helpers', () => {
  it('parses explicit verification results through shared schema', () => {
    const result = createVerificationResult({
      verifierId: 'rule-schema-v1',
      verifierKind: 'rule',
      verdict: 'fail',
      summary: 'Schema verifier found invalid output shape.',
      reasons: ['Output omitted required `steps` array.'],
      suggestedAction: 'retry',
      findings: [
        {
          code: 'schema_missing_steps',
          summary: 'Missing steps field',
          detail: 'Response must include `steps` array.',
          severity: 'fail',
        },
      ],
    });

    expect(result.verifierKind).toBe('rule');
    expect(result.verdict).toBe('fail');
    expect(result.suggestedAction).toBe('retry');
  });

  it('creates deferred warning result for skipped verifier stage', () => {
    const result = createDeferredVerificationResult(
      'Verifier deferred until strategy-specific implementation lands.',
      ['No low-cost verifier ran for this response.'],
    );

    expect(result.verifierKind).toBe('model');
    expect(result.verdict).toBe('warning');
    expect(result.suggestedAction).toBe('manual-confirm');
    expect(result.findings[0]?.severity).toBe('warning');
  });

  it('builds verifier prompt from output, constraints, and planner checks', () => {
    const prompt = buildVerifierUserPrompt({
      taskRequest: baseTaskRequest,
      structurizerResult: baseStructurizerResult,
      routeDecision: baseRouteDecision,
      plannerResult: basePlannerResult,
      reasonerResult: baseReasonerResult,
      providerResult: baseProviderResult,
      output: baseProviderResult.outputText,
    });

    expect(prompt).toContain('Constraints:');
    expect(prompt).toContain('Planner verifier checks:');
    expect(prompt).toContain('Executor output to verify:');
    expect(prompt).toContain('Check public API stability.');
  });

  it('parses fenced JSON output and normalizes proceed on warning', () => {
    const result = parseVerificationOutput(`\`\`\`json
{
  "verifierId": "model-consistency-v1",
  "verifierKind": "model",
  "verdict": "warning",
  "summary": "Output missed one formatting rule.",
  "reasons": ["Response skipped the requested numbered format."],
  "suggestedAction": "proceed",
  "findings": [
    {
      "code": "format_mismatch",
      "summary": "Format mismatch",
      "detail": "Response was prose only.",
      "severity": "warning"
    }
  ]
}
\`\`\``);

    expect(result.verdict).toBe('warning');
    expect(result.suggestedAction).toBe('manual-confirm');
    expect(result.findings[0]?.code).toBe('format_mismatch');
  });

  it('returns parsed model verdict from verifier provider', async () => {
    const invoke = vi.fn().mockResolvedValue({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      outputText: JSON.stringify({
        verifierId: 'model-consistency-v1',
        verifierKind: 'model',
        verdict: 'fail',
        summary: 'Output invented a migration step.',
        reasons: ['Plan never authorized schema migration.'],
        suggestedAction: 'upgrade-model',
        findings: [
          {
            code: 'reasoning_gap',
            summary: 'Reasoning gap',
            detail: 'Output proposed migration without supporting evidence.',
            severity: 'fail',
          },
        ],
      }),
    });

    const result = await verifyTaskWithModel(
      { invoke },
      'gpt-4o-mini',
      {
        taskRequest: baseTaskRequest,
        structurizerResult: baseStructurizerResult,
        routeDecision: baseRouteDecision,
        plannerResult: basePlannerResult,
        reasonerResult: baseReasonerResult,
        providerResult: baseProviderResult,
        output: baseProviderResult.outputText,
      },
    );

    expect(result.verdict).toBe('fail');
    expect(result.suggestedAction).toBe('upgrade-model');
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'gpt-4o-mini',
      systemPrompt: expect.stringContaining('Return strict JSON only'),
      metadata: expect.objectContaining({
        verifierId: 'model-consistency-v1',
      }),
    }));
  });

  it('falls back to retry warning when verifier provider fails', async () => {
    const result = await verifyTaskWithModel(
      {
        invoke: vi.fn().mockRejectedValue(new Error('verifier offline')),
      },
      'gpt-4o-mini',
      {
        taskRequest: baseTaskRequest,
        structurizerResult: baseStructurizerResult,
        routeDecision: baseRouteDecision,
        plannerResult: basePlannerResult,
        reasonerResult: baseReasonerResult,
        providerResult: baseProviderResult,
        output: baseProviderResult.outputText,
      },
    );

    expect(result.verdict).toBe('warning');
    expect(result.suggestedAction).toBe('retry');
    expect(result.summary).toContain('Model verifier unavailable');
  });

  it('fails explicit numbered-list hard rule through rule verifier hook', async () => {
    const results = await runRuleVerifiers(
      {
        taskRequest: {
          ...baseTaskRequest,
          constraints: [...baseTaskRequest.constraints, 'Return numbered list output.'],
        },
        structurizerResult: {
          ...baseStructurizerResult,
          structuredTask: {
            ...baseStructurizerResult.structuredTask,
            constraints: [...baseStructurizerResult.structuredTask.constraints, 'Return numbered list output.'],
            expectedOutput: ['Use numbered list format in final answer.'],
          },
        },
        routeDecision: baseRouteDecision,
        plannerResult: basePlannerResult,
        reasonerResult: baseReasonerResult,
        providerResult: {
          ...baseProviderResult,
          outputText: 'Risk A only. No numbering here.',
        },
        output: 'Risk A only. No numbering here.',
      },
      [createListFormatRuleVerifier()],
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.verifierKind).toBe('rule');
    expect(results[0]?.verdict).toBe('fail');
    expect(results[0]?.findings[0]?.code).toBe('format_numbered_list_missing');
    expect(results[0]?.findings[0]?.verifierKind).toBe('rule');
  });

  it('returns safe warning result when rule verifier crashes', async () => {
    const results = await runRuleVerifiers(
      {
        taskRequest: baseTaskRequest,
        structurizerResult: baseStructurizerResult,
        routeDecision: baseRouteDecision,
        plannerResult: basePlannerResult,
        reasonerResult: baseReasonerResult,
        providerResult: baseProviderResult,
        output: baseProviderResult.outputText,
      },
      [
        {
          verifierId: 'rule-crash-v1',
          verifierKind: 'rule',
          verify() {
            throw new Error('rule exploded');
          },
        },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.verifierId).toBe('rule-crash-v1');
    expect(results[0]?.verdict).toBe('warning');
    expect(results[0]?.suggestedAction).toBe('manual-confirm');
    expect(results[0]?.findings[0]?.code).toContain('rule_verifier_failure');
  });

  it('merges model and rule verifier results into composite output', () => {
    const merged = mergeVerificationResults([
      createVerificationResult({
        verifierId: 'model-consistency-v1',
        verifierKind: 'model',
        verdict: 'pass',
        summary: 'Model verifier passed.',
        reasons: ['No model inconsistency found.'],
        suggestedAction: 'proceed',
        findings: [],
      }),
      createVerificationResult({
        verifierId: 'rule-output-format-v1',
        verifierKind: 'rule',
        verdict: 'fail',
        summary: 'Numbered list rule failed.',
        reasons: ['Output did not satisfy explicit numbered list requirement.'],
        suggestedAction: 'retry',
        findings: [
          {
            code: 'format_numbered_list_missing',
            summary: 'Numbered list rule failed.',
            detail: 'Expected at least one numbered item.',
            severity: 'fail',
          },
        ],
      }),
    ]);

    expect(merged.verifierKind).toBe('composite');
    expect(merged.verdict).toBe('fail');
    expect(merged.suggestedAction).toBe('retry');
    expect(merged.summary).toContain('model-consistency-v1=pass');
    expect(merged.summary).toContain('rule-output-format-v1=fail');
    expect(merged.findings.some((finding) => finding.verifierKind === 'rule')).toBe(true);
  });
});