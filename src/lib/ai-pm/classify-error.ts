export type ErrorKind =
  | 'API_ERROR'
  | 'INSUFFICIENT_MARGIN'
  | 'INVALID_PARAMS'
  | 'ORDER_REJECTED'
  | 'UNKNOWN';

export function classifyError(err: unknown): ErrorKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient/i.test(msg)) return 'INSUFFICIENT_MARGIN';
  if (/invalid/i.test(msg)) return 'INVALID_PARAMS';
  if (/rejected/i.test(msg)) return 'ORDER_REJECTED';
  if (/api|bingx|http/i.test(msg)) return 'API_ERROR';
  return 'UNKNOWN';
}
