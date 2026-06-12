/**
 * Deterministic clientOrderID scheme for grid orders.
 *
 * entry: "ge" + bot8 + lvl8 + nonce
 * tp:    "gt" + bot8 + lvl8 + nonce
 *
 * bot8/lvl8 = first 8 hex chars of the UUID (dashes stripped). Alphanumeric only,
 * ≤ 40 chars (BingX clientOrderID limit). The nonce is generated once per analysis
 * step and memoized by Inngest, so retries reuse the same CID — that is the
 * idempotency key that lets a retry adopt an already-placed order instead of
 * placing a duplicate. lvl8 ties an exchange order to a gridLevels row; levels
 * recreated by an edit get new UUIDs, so stale orders are detectable by construction.
 */

const ENTRY_PREFIX = 'ge';
const TP_PREFIX = 'gt';
const SHORT_ID_LEN = 8;

export function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, SHORT_ID_LEN).toLowerCase();
}

export function makeNonce(now: number = Date.now()): string {
  return now.toString(36);
}

export function buildEntryCid(botId: string, levelId: string, nonce: string): string {
  return `${ENTRY_PREFIX}${shortId(botId)}${shortId(levelId)}${nonce}`;
}

export function buildTpCid(botId: string, levelId: string, nonce: string): string {
  return `${TP_PREFIX}${shortId(botId)}${shortId(levelId)}${nonce}`;
}

/** Ownership prefix for all entry CIDs of a bot — used by the reconciliation sweep. */
export function entryCidBotPrefix(botId: string): string {
  return `${ENTRY_PREFIX}${shortId(botId)}`;
}

/** True if the CID (entry or TP) belongs to this bot+level. */
export function cidMatchesLevel(
  cid: string | null | undefined,
  botId: string,
  levelId: string
): boolean {
  if (!cid) return false;
  const body = shortId(botId) + shortId(levelId);
  return cid.startsWith(ENTRY_PREFIX + body) || cid.startsWith(TP_PREFIX + body);
}

/** Extract the lvl8 segment from one of this bot's entry CIDs, or null if not ours. */
export function parseLevelShortId(cid: string, botId: string): string | null {
  const prefix = entryCidBotPrefix(botId);
  if (!cid.startsWith(prefix)) return null;
  const lvl8 = cid.slice(prefix.length, prefix.length + SHORT_ID_LEN);
  return lvl8.length === SHORT_ID_LEN ? lvl8 : null;
}
