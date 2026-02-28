import { createHmac } from 'node:crypto';

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

  return sortedKeys
    .map((key) => `${key}=${params[key]}`)
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
 */
export function signParams(
  params: Record<string, string | number | undefined>,
  secretKey: string,
  recvWindow = 60000
): Record<string, string | number> {
  const timestamp = Date.now();
  const paramsWithTime = { ...params, recvWindow, timestamp };

  const signingString = buildSigningString(paramsWithTime);
  const signature = generateSignature(signingString, secretKey);

  return {
    ...paramsWithTime,
    signature,
  };
}
