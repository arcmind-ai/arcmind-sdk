export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
}

const MAX_DELAY_MS = 30_000;

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 500 } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof NonRetryableError) throw error;

      lastError = error;
      if (attempt < maxAttempts - 1) {
        const jitter = Math.random() * 0.5 + 0.75;
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt) * jitter,
          MAX_DELAY_MS
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
