import { signParams, buildSigningString, buildQueryStringForUrl } from './signature';
import JSONBig from 'json-bigint';

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

    const res = await fetch(url.toString(), options);
    const responseText = await res.text();
    const json = JSONBig({ storeAsString: true }).parse(responseText) as BingxApiResponse<T>;

    if (!res.ok) {
      throw new Error(json.msg || `BingX API error: ${res.status}`);
    }

    if (json.code !== undefined && json.code !== 0) {
      throw new Error(json.msg || `BingX API code ${json.code}`);
    }

    return (json.data ?? json) as T;
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
      const body = `${bodyParts}&signature=${encodeURIComponent(signature)}`;

      return (async () => {
        const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
        const res = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'X-BX-APIKEY': apiKey.trim(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        });
        const responseText = await res.text();
        const json = JSONBig({ storeAsString: true }).parse(responseText) as BingxApiResponse<T>;
        if (!res.ok) {
          throw new Error(json.msg || `BingX API error: ${res.status}`);
        }
        if (json.code !== undefined && json.code !== 0) {
          throw new Error(json.msg || `BingX API code ${json.code}`);
        }
        return (json.data ?? json) as T;
      })();
    },
  };
}

export type BingxClient = ReturnType<typeof createBingxClient>;
