import { describe, expect, it } from 'vitest';
import { TaskRequestSchema } from '@llm-crane/schemas';
import {
  ConfigurationError,
  createDiagnosticError,
  createDiagnosticFromError,
  createProviderDiagnostic,
} from '../src/index';

describe('diagnostics', () => {
  it('maps configuration errors to configuration diagnostics', () => {
    const diagnostic = createDiagnosticFromError(new ConfigurationError('Missing API key for configured model: gpt-4o-mini'), {
      category: 'internal',
      code: 'internal.unexpected',
      summary: 'Unexpected error',
      message: 'Unexpected error.',
      stage: 'bootstrap',
    });

    expect(diagnostic.category).toBe('configuration');
    expect(diagnostic.code).toBe('configuration.invalid_runtime');
  });

  it('maps schema parse failures to schema diagnostics', () => {
    let parseError: unknown;

    try {
      TaskRequestSchema.parse({ task: '' });
    } catch (error) {
      parseError = error;
    }

    const diagnostic = createDiagnosticFromError(parseError, {
      category: 'internal',
      code: 'internal.unexpected',
      summary: 'Unexpected error',
      message: 'Unexpected error.',
      stage: 'request.parse',
    });

    expect(diagnostic.category).toBe('schema');
    expect(diagnostic.code).toBe('schema.invalid_payload');
    expect(diagnostic.message).toContain('Payload failed schema validation');
  });

  it('maps provider failures to provider diagnostics', () => {
    const diagnostic = createProviderDiagnostic(
      {
        providerId: 'openai',
        code: 'rate_limit',
        message: 'Rate limit exceeded',
        retriable: true,
        statusCode: 429,
      },
      'executor.invoke',
    );

    expect(diagnostic.category).toBe('provider');
    expect(diagnostic.code).toBe('provider.rate_limit');
    expect(diagnostic.retriable).toBe(true);
  });

  it('wraps fallback diagnostics into diagnostic errors', () => {
    const diagnosticError = createDiagnosticError(new Error('boom'), {
      category: 'internal',
      code: 'internal.unexpected',
      summary: 'Unexpected error',
      message: 'LLM Crane hit unexpected internal failure.',
      stage: 'extension.runTask',
    });

    expect(diagnosticError.diagnostic.category).toBe('internal');
    expect(diagnosticError.diagnostic.message).toBe('LLM Crane hit unexpected internal failure.');
  });
});