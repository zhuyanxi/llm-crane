import {
  DiagnosticSchema,
  type Diagnostic,
  type DiagnosticCategory,
  type ProviderApiFamily,
  type ProviderDeploymentMode,
  type ProviderError,
} from '@llm-crane/schemas';
import { ConfigurationError, SubprocessNotRunningError } from './errors';

type ProviderDiagnosticContext = {
  runtimeId?: string;
  deploymentMode?: ProviderDeploymentMode;
  apiFamily?: ProviderApiFamily;
};

type DiagnosticFallback = {
  category: DiagnosticCategory;
  code: string;
  summary: string;
  message: string;
  stage?: string;
  retriable?: boolean;
};

type ZodIssueLike = {
  path?: Array<string | number>;
  message?: string;
};

type ZodErrorLike = Error & {
  issues?: ZodIssueLike[];
};

export class LLMCraneDiagnosticError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    const parsed = DiagnosticSchema.parse(diagnostic);
    super(parsed.message);
    this.name = 'LLMCraneDiagnosticError';
    this.diagnostic = parsed;
  }
}

function isZodErrorLike(error: unknown): error is ZodErrorLike {
  return error instanceof Error && error.name === 'ZodError';
}

function getFirstIssue(error: ZodErrorLike): ZodIssueLike | undefined {
  return Array.isArray(error.issues) && error.issues.length > 0 ? error.issues[0] : undefined;
}

function formatIssuePath(issue: ZodIssueLike | undefined): string {
  if (!issue?.path || issue.path.length === 0) {
    return 'payload';
  }

  return issue.path.map((segment) => String(segment)).join('.');
}

function buildSchemaMessage(error: ZodErrorLike): string {
  const issue = getFirstIssue(error);
  if (!issue?.message) {
    return 'Payload failed schema validation.';
  }

  return `Payload failed schema validation at ${formatIssuePath(issue)}: ${issue.message}`;
}

function buildProviderSummary(providerError: ProviderError, context?: ProviderDiagnosticContext): string {
  if (context?.deploymentMode === 'local') {
    switch (providerError.code) {
      case 'auth':
        return 'Local runtime authentication failed';
      case 'rate_limit':
        return 'Local runtime rate limit hit';
      case 'timeout':
        return 'Local runtime timed out';
      case 'invalid_request':
        return 'Local runtime rejected request';
      case 'network':
        return 'Local runtime unavailable';
      case 'unsupported_model':
        return 'Local model unavailable';
      case 'provider_not_configured':
        return 'Local runtime not configured';
      case 'upstream':
        return 'Local runtime upstream failure';
      case 'unknown':
        return 'Local runtime request failed';
    }
  }

  switch (providerError.code) {
    case 'auth':
      return 'Provider authentication failed';
    case 'rate_limit':
      return 'Provider rate limit hit';
    case 'timeout':
      return 'Provider timed out';
    case 'invalid_request':
      return 'Provider rejected request';
    case 'network':
      return 'Provider network failure';
    case 'unsupported_model':
      return 'Configured model unsupported';
    case 'provider_not_configured':
      return 'Provider not configured';
    case 'upstream':
      return 'Provider upstream failure';
    case 'unknown':
      return 'Provider request failed';
  }
}

export function createProviderDiagnostic(
  providerError: ProviderError,
  stage = 'executor.invoke',
  context: ProviderDiagnosticContext = {},
): Diagnostic {
  return DiagnosticSchema.parse({
    category: 'provider',
    code: `provider.${providerError.code}`,
    summary: buildProviderSummary(providerError, context),
    message: providerError.message,
    retriable: providerError.retriable,
    providerId: providerError.providerId,
    runtimeId: context.runtimeId,
    deploymentMode: context.deploymentMode,
    apiFamily: context.apiFamily,
    stage,
  });
}

export function createDiagnosticFromError(error: unknown, fallback: DiagnosticFallback): Diagnostic {
  if (error instanceof LLMCraneDiagnosticError) {
    return error.diagnostic;
  }

  if (error instanceof ConfigurationError) {
    return DiagnosticSchema.parse({
      category: 'configuration',
      code: 'configuration.invalid_runtime',
      summary: 'Configuration issue',
      message: error.message,
      stage: fallback.stage,
    });
  }

  if (error instanceof SubprocessNotRunningError) {
    return DiagnosticSchema.parse({
      category: 'internal',
      code: 'internal.subprocess_not_running',
      summary: 'Local orchestrator unavailable',
      message: error.message,
      stage: fallback.stage,
    });
  }

  if (isZodErrorLike(error)) {
    return DiagnosticSchema.parse({
      category: 'schema',
      code: 'schema.invalid_payload',
      summary: 'Schema validation failed',
      message: buildSchemaMessage(error),
      stage: fallback.stage,
    });
  }

  if (error instanceof Error && /timed out/i.test(error.message)) {
    return DiagnosticSchema.parse({
      category: 'internal',
      code: 'internal.timeout',
      summary: 'Local orchestrator timed out',
      message: error.message,
      stage: fallback.stage,
      retriable: true,
    });
  }

  return DiagnosticSchema.parse({
    category: fallback.category,
    code: fallback.code,
    summary: fallback.summary,
    message: fallback.message,
    stage: fallback.stage,
    retriable: fallback.retriable,
  });
}

export function createDiagnosticError(error: unknown, fallback: DiagnosticFallback): LLMCraneDiagnosticError {
  return error instanceof LLMCraneDiagnosticError ? error : new LLMCraneDiagnosticError(createDiagnosticFromError(error, fallback));
}

export function formatDiagnosticLog(diagnostic: Diagnostic): string {
  const runtimeSuffix = diagnostic.runtimeId ? ` runtime=${diagnostic.runtimeId}` : '';
  const deploymentSuffix = diagnostic.deploymentMode ? ` deployment=${diagnostic.deploymentMode}` : '';
  const apiFamilySuffix = diagnostic.apiFamily ? ` apiFamily=${diagnostic.apiFamily}` : '';
  return `category=${diagnostic.category} code=${diagnostic.code} summary=${diagnostic.summary} message=${diagnostic.message}${runtimeSuffix}${deploymentSuffix}${apiFamilySuffix}`;
}