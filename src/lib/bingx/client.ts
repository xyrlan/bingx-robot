import { signParams, buildQueryStringForUrl } from './signature';
import JSONBig from 'json-bigint';
import { BingxApiError, BingxRateLimitError, BingxAuthError, BingxInsufficientBalanceError, isRetryableError } from './errors';

const BASE_URL = 'https://open-api.bingx.com';

type BingxApiResponse<T = unknown> = {
  code?: number;
  msg?: string;
  data?: T;
};

export function createBingxClient(apiKey: string, secretKey: string, recvWindow = 60000) {
  const headers: Record<string, string> = {
    'X-BX-APIKEY': apiKey.trim(),
    'Content-Type': 'application/json',
  };

  const REQUEST_TIMEOUT_MS = 30_000;
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  function classifyError(msg: string, code: number, statusCode?: number): BingxApiError {
    const msgLower = msg.toLowerCase();

    // Rate limiting
    if (statusCode === 429 || code === 429 || msgLower.includes('rate limit') || msgLower.includes('too many request')) {
      return new BingxRateLimitError(msg, code);
    }

    // Auth errors
    if (statusCode === 401 || statusCode === 403 ||
        msgLower.includes('signature') || msgLower.includes('api key') ||
        msgLower.includes('unauthorized') || msgLower.includes('permission') ||
        code === 100001 || code === 100412 || code === 100413 || code === 100202) {
      return new BingxAuthError(msg, code);
    }

    // Insufficient balance
    if (msgLower.includes('insufficient') || msgLower.includes('balance') ||
        msgLower.includes('margin') || code === 101204) {
      return new BingxInsufficientBalanceError(msg, code);
    }

    return new BingxApiError(msg, code, statusCode);
  }

  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt >= MAX_RETRIES || !isRetryableError(error)) {
          throw error;
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async function request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params?: Record<string, string | number | undefined>,
    body?: Record<string, unknown>,
    useQueryParams = false,
    omitRecvWindow = false
  ): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);

    const paramsToSign =
      method === 'GET' || method === 'DELETE'
        ? (params ?? {})
        : (body as Record<string, string | number | undefined>) ?? {};
    const signedParams = signParams(
      paramsToSign,
      secretKey.trim(),
      recvWindow,
      omitRecvWindow
    );

    if (method === 'GET' || method === 'DELETE' || useQueryParams) {
      const { signature, ...paramsForQuery } = signedParams;
      const paramsForUrl = paramsForQuery as Record<string, string | number | undefined>;
      const queryWithoutSig = buildQueryStringForUrl(paramsForUrl);
      url.search = `${queryWithoutSig}&signature=${encodeURIComponent(signature)}`;
    }

    const requestHeaders = { ...headers };
    if ((method === 'POST' && useQueryParams) || method === 'DELETE') {
      delete requestHeaders['Content-Type'];
    }
    const options: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (method !== 'GET' && !useQueryParams && body) {
      options.body = JSON.stringify({ ...body, ...signedParams });
    } else if (method === 'POST' && useQueryParams) {
      const { signature, ...paramsForQuery } = signedParams;
      const paramsForUrl = paramsForQuery as Record<string, string | number | undefined>;
      const queryWithoutSig = buildQueryStringForUrl(paramsForUrl);
      url.search = `${queryWithoutSig}&signature=${encodeURIComponent(signature)}`;
    }

    return withRetry(async () => {
      const res = await fetch(url.toString(), {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const responseText = await res.text();
      const json = JSONBig({ storeAsString: true }).parse(responseText) as BingxApiResponse<T>;

      if (!res.ok) {
        throw classifyError(
          json.msg || `BingX API error: ${res.status}`,
          json.code ?? res.status,
          res.status
        );
      }

      if (json.code !== undefined && json.code !== 0) {
        throw classifyError(
          json.msg || `BingX API code ${json.code}`,
          json.code
        );
      }

      return (json.data ?? json) as T;
    });
  }

  return {
    get<T = unknown>(path: string, params?: Record<string, string | number | undefined>) {
      return request<T>('GET', path, params);
    },

    post<T = unknown>(
      path: string,
      body?: Record<string, unknown>,
      useQueryParams = false
    ) {
      return request<T>('POST', path, undefined, body, useQueryParams);
    },

    delete<T = unknown>(
      path: string,
      params?: Record<string, string | number | undefined>,
      options?: { omitRecvWindow?: boolean }
    ) {
      return request<T>(
        'DELETE',
        path,
        params,
        undefined,
        false,
        options?.omitRecvWindow ?? false
      );
    },

    postForm<T = unknown>(
      path: string,
      params?: Record<string, string | number | undefined>
    ) {
      const paramsToSign = params ?? {};
      const signedParams = signParams(paramsToSign, secretKey.trim(), recvWindow, false);
      const { signature, ...restParams } = signedParams;
      const bodyParts = Object.entries(restParams)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      const formBody = `${bodyParts}&signature=${encodeURIComponent(signature)}`;

      return (async () => {
        const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
        return withRetry(async () => {
          const res = await fetch(url.toString(), {
            method: 'POST',
            headers: {
              'X-BX-APIKEY': apiKey.trim(),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formBody,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          const responseText = await res.text();
          const json = JSONBig({ storeAsString: true }).parse(responseText) as BingxApiResponse<T>;
          if (!res.ok) {
            throw classifyError(
              json.msg || `BingX API error: ${res.status}`,
              json.code ?? res.status,
              res.status
            );
          }
          if (json.code !== undefined && json.code !== 0) {
            throw classifyError(
              json.msg || `BingX API code ${json.code}`,
              json.code
            );
          }
          return (json.data ?? json) as T;
        });
      })();
    },
  };
}

export type BingxClient = ReturnType<typeof createBingxClient>;

export { BingxApiError, BingxRateLimitError, BingxAuthError, BingxInsufficientBalanceError, isRetryableError } from './errors';
