import type { ProviderId } from './catalog';

export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'invalid_request'
  | 'network'
  | 'unsupported_model'
  | 'provider_not_configured'
  | 'upstream'
  | 'unknown';

type ProviderInvocationErrorOptions = {
  providerId: ProviderId;
  code: ProviderErrorCode;
  retriable: boolean;
  statusCode?: number;
  details?: unknown;
  cause?: unknown;
};

export class ProviderInvocationError extends Error {
  readonly providerId: ProviderId;
  readonly code: ProviderErrorCode;
  readonly retriable: boolean;
  readonly statusCode?: number;
  readonly details?: unknown;

  constructor(message: string, options: ProviderInvocationErrorOptions) {
    super(message);
    this.name = 'ProviderInvocationError';
    this.providerId = options.providerId;
    this.code = options.code;
    this.retriable = options.retriable;
    this.statusCode = options.statusCode;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}