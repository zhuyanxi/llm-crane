import { describe, expect, it } from 'vitest';
import { createDeferredVerificationResult, createVerificationResult } from '../src/verifier';

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
});