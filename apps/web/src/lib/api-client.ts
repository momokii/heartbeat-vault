import { z } from 'zod';

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api';

export type ApiErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'VALIDATION_ERROR' | 'HTTP_ERROR';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly cause_: unknown;

  constructor(
    message: string,
    code: ApiErrorCode,
    status: number | null = null,
    cause: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.cause_ = cause;
  }
}

export type ApiClientOptions = {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
};

export type RequestOptions<T> = {
  readonly method?: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
};

function buildUrl(
  base: string,
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${normalizedBase}${normalizedPath}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Typed fetch wrapper. Validates JSON responses with Zod.
 * No auth logic here — placeholder for future token/session integration (T7.2+).
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? API_BASE_URL;
  const defaultTimeout = options.timeoutMs ?? 10_000;
  const defaultHeaders = options.defaultHeaders ?? {};

  async function request<T>(opts: RequestOptions<T>): Promise<T> {
    const url = buildUrl(baseUrl, opts.path, opts.query);
    const method = opts.method ?? 'GET';
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const signal: AbortSignal | undefined = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...defaultHeaders,
      ...(opts.headers ?? {}),
    };

    let response: Response;
    try {
      const init: RequestInit = { method, headers, signal };
      if (opts.body !== undefined) {
        (init as { body: string }).body = JSON.stringify(opts.body);
      }
      response = await fetch(url, init);
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiError('Request timed out', 'TIMEOUT', null, err);
      }
      throw new ApiError('Network error', 'NETWORK_ERROR', null, err);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new ApiError(
        `HTTP ${response.status}: ${response.statusText}`,
        'HTTP_ERROR',
        response.status,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (response.status === 204 || !contentType.includes('application/json')) {
      // For non-JSON or empty, validate against schema if schema allows; otherwise return as-is via parse
      // Placeholder: if empty 204, zod should handle void/empty schema.
      const text = await response.text();
      if (!text) {
        // Try parsing empty as undefined for void schemas
        const parsed = opts.schema.safeParse(undefined);
        if (parsed.success) return parsed.data;
        throw new ApiError(
          'Empty response failed validation',
          'VALIDATION_ERROR',
          response.status,
          parsed.error,
        );
      }
      // Non-JSON text: treat as error unless schema accepts string
      throw new ApiError('Expected JSON response', 'VALIDATION_ERROR', response.status);
    }

    const json: unknown = await response.json();
    const result = opts.schema.safeParse(json);
    if (!result.success) {
      throw new ApiError(
        'Response validation failed',
        'VALIDATION_ERROR',
        response.status,
        result.error,
      );
    }
    return result.data;
  }

  return { request, baseUrl };
}

// Default singleton for app use (env-driven base URL)
export const apiClient = createApiClient();

// Example placeholder schema (health check) — not wired, for pattern reference
export const HealthSchema = z.object({
  status: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;
