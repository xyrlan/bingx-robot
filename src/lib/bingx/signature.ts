import { createHmac } from 'node:crypto';

/**
 * Normalize param values for signing - BingX is strict about whitespace/encoding.
 * String values are trimmed; numbers passed through.
 */
function normalizeParamValue(v: string | number | undefined): string | number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/**
 * Build signing string per BingX API v3 spec.
 * - Sort params by key in ASCII ascending order
 * - Values must NOT be URL-encoded in the signing string
 * @see https://bingx-api.github.io/docs-v3/#/en/Quick%20Start/Signature%20Authentication
 */
export function buildSigningString(params: Record<string, string | number | undefined>): string {
  const sortedKeys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sortedKeys.map((key) => `${key}=${params[key]}`).join('&');
}

/**
 * Build query string for request URL. When signing string contains [ or {,
 * URL-encode parameter values per BingX spec.
 */
export function buildQueryStringForUrl(params: Record<string, string | number | undefined>): string {
  const sortedKeys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const signingStr = sortedKeys.map((key) => `${key}=${params[key]}`).join('&');
  const needsEncoding = signingStr.includes('[') || signingStr.includes('{');
  return sortedKeys
    .map((key) => {
      const v = params[key];
      const valStr = String(v);
      return `${key}=${needsEncoding ? encodeURIComponent(valStr) : valStr}`;
    })
    .join('&');
}

/**
 * Generate HMAC-SHA256 signature, returns 64-char lowercase hex.
 */
export function generateSignature(signingString: string, secretKey: string): string {
  const key = secretKey.trim();
  return createHmac('sha256', key).update(signingString, 'utf8').digest('hex');
}

/**
 * Add timestamp and signature to params. Excludes signature from signing.
 * Normalizes all param values (trim strings) before signing so URL and signing string match.
 * @param omitRecvWindow - When true, omit recvWindow (matches BingX batchOrders sample: orderIdList, symbol, timestamp only)
 */
export function signParams(
  params: Record<string, string | number | undefined>,
  secretKey: string,
  recvWindow = 60000,
  omitRecvWindow = false
): Record<string, string | number> {
  const normalized: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(params)) {
    const nv = normalizeParamValue(v);
    if (nv !== undefined) normalized[k] = nv;
  }
  const timestamp = Date.now();
  const paramsWithTime = omitRecvWindow
    ? { ...normalized, timestamp }
    : { ...normalized, recvWindow, timestamp };

  const signingString = buildSigningString(paramsWithTime);
  const signature = generateSignature(signingString, secretKey);

  if (process.env.NODE_ENV === 'development') {
    console.debug('[BingX] signing string:', signingString);
  }

  return {
    ...paramsWithTime,
    signature,
  };
}
