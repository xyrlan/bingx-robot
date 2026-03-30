/**
 * Base error for all BingX API errors.
 */
export class BingxApiError extends Error {
  public readonly code: number;
  public readonly statusCode?: number;

  constructor(message: string, code: number, statusCode?: number) {
    super(message);
    this.name = 'BingxApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Rate limit exceeded (HTTP 429 or BingX rate limit codes).
 */
export class BingxRateLimitError extends BingxApiError {
  constructor(message: string, code: number = 429) {
    super(message, code, 429);
    this.name = 'BingxRateLimitError';
  }
}

/**
 * Authentication/authorization error (invalid API key, expired signature, etc.).
 */
export class BingxAuthError extends BingxApiError {
  constructor(message: string, code: number = 401) {
    super(message, code, 401);
    this.name = 'BingxAuthError';
  }
}

/**
 * Insufficient balance or margin error.
 */
export class BingxInsufficientBalanceError extends BingxApiError {
  constructor(message: string, code: number) {
    super(message, code);
    this.name = 'BingxInsufficientBalanceError';
  }
}

/** Check if an error is retryable (rate limits, server errors, network issues) */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof BingxRateLimitError) return true;
  if (error instanceof BingxAuthError) return false;
  if (error instanceof BingxInsufficientBalanceError) return false;
  if (error instanceof BingxApiError) {
    // Server errors are retryable
    return (error.statusCode ?? 0) >= 500;
  }
  // Network errors are retryable
  if (error instanceof TypeError && error.message.includes('fetch')) return true;
  return false;
}
