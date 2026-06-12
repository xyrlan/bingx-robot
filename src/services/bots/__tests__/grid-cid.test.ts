import { describe, it, expect } from 'vitest';
import {
  shortId,
  makeNonce,
  buildEntryCid,
  buildTpCid,
  entryCidBotPrefix,
  cidMatchesLevel,
  parseLevelShortId,
} from '@/services/bots/grid-cid';

const BOT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const LEVEL_ID = 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d';
const OTHER_LEVEL_ID = 'ffffffff-0000-4111-8222-333344445555';
const OTHER_BOT_ID = 'deadbeef-1111-4222-8333-444455556666';

describe('shortId', () => {
  it('returns first 8 hex chars with dashes stripped, lowercased', () => {
    expect(shortId(BOT_ID)).toBe('3fa85f64');
    expect(shortId('A1B2C3D4-e5f6-4a5b-8c7d-9e0f1a2b3c4d')).toBe('a1b2c3d4');
  });
});

describe('makeNonce', () => {
  it('encodes timestamp as base36', () => {
    expect(makeNonce(1700000000000)).toBe((1700000000000).toString(36));
  });
});

describe('buildEntryCid / buildTpCid', () => {
  const nonce = makeNonce(1700000000000);

  it('builds alphanumeric CID of at most 40 chars', () => {
    const cid = buildEntryCid(BOT_ID, LEVEL_ID, nonce);
    expect(cid.length).toBeLessThanOrEqual(40);
    expect(cid).toMatch(/^[a-z0-9]+$/);
  });

  it('entry and TP CIDs for the same level differ', () => {
    expect(buildEntryCid(BOT_ID, LEVEL_ID, nonce)).not.toBe(buildTpCid(BOT_ID, LEVEL_ID, nonce));
  });

  it('is deterministic for same inputs, differs for different nonce', () => {
    expect(buildEntryCid(BOT_ID, LEVEL_ID, nonce)).toBe(buildEntryCid(BOT_ID, LEVEL_ID, nonce));
    expect(buildEntryCid(BOT_ID, LEVEL_ID, 'aaaa')).not.toBe(buildEntryCid(BOT_ID, LEVEL_ID, 'bbbb'));
  });

  it('embeds bot and level short ids', () => {
    const cid = buildEntryCid(BOT_ID, LEVEL_ID, nonce);
    expect(cid.startsWith('ge3fa85f64a1b2c3d4')).toBe(true);
  });
});

describe('entryCidBotPrefix', () => {
  it('prefixes ge + bot short id', () => {
    expect(entryCidBotPrefix(BOT_ID)).toBe('ge3fa85f64');
  });
});

describe('cidMatchesLevel', () => {
  const nonce = makeNonce(1700000000000);
  const entryCid = buildEntryCid(BOT_ID, LEVEL_ID, nonce);
  const tpCid = buildTpCid(BOT_ID, LEVEL_ID, nonce);

  it('matches own entry and TP CIDs', () => {
    expect(cidMatchesLevel(entryCid, BOT_ID, LEVEL_ID)).toBe(true);
    expect(cidMatchesLevel(tpCid, BOT_ID, LEVEL_ID)).toBe(true);
  });

  it('rejects other level, other bot, undefined and foreign CIDs', () => {
    expect(cidMatchesLevel(entryCid, BOT_ID, OTHER_LEVEL_ID)).toBe(false);
    expect(cidMatchesLevel(entryCid, OTHER_BOT_ID, LEVEL_ID)).toBe(false);
    expect(cidMatchesLevel(undefined, BOT_ID, LEVEL_ID)).toBe(false);
    expect(cidMatchesLevel('someuserorder123', BOT_ID, LEVEL_ID)).toBe(false);
  });
});

describe('parseLevelShortId', () => {
  const nonce = makeNonce(1700000000000);

  it('extracts level short id from own entry CID', () => {
    const cid = buildEntryCid(BOT_ID, LEVEL_ID, nonce);
    expect(parseLevelShortId(cid, BOT_ID)).toBe('a1b2c3d4');
  });

  it('returns null for foreign or TP CIDs', () => {
    expect(parseLevelShortId('someuserorder123', BOT_ID)).toBeNull();
    expect(parseLevelShortId(buildEntryCid(OTHER_BOT_ID, LEVEL_ID, nonce), BOT_ID)).toBeNull();
    expect(parseLevelShortId(buildTpCid(BOT_ID, LEVEL_ID, nonce), BOT_ID)).toBeNull();
  });
});
