/**
 * Curated list of major BingX USDT perpetual symbols offered in the AI PM
 * config UI. `code` is the raw exchange symbol stored in `allowedSymbols` and
 * used by the signal layer / BingX API; `name` is the friendly label shown to
 * the user. Keep this list to liquid majors — it is a UX whitelist, not the
 * full exchange catalogue.
 */
export interface AiPmSymbol {
  code: string;
  name: string;
}

export const AI_PM_SYMBOLS: AiPmSymbol[] = [
  { code: 'BTC-USDT', name: 'Bitcoin' },
  { code: 'ETH-USDT', name: 'Ethereum' },
  { code: 'SOL-USDT', name: 'Solana' },
  { code: 'BNB-USDT', name: 'BNB' },
  { code: 'XRP-USDT', name: 'XRP' },
  { code: 'DOGE-USDT', name: 'Dogecoin' },
  { code: 'ADA-USDT', name: 'Cardano' },
  { code: 'AVAX-USDT', name: 'Avalanche' },
  { code: 'LINK-USDT', name: 'Chainlink' },
  { code: 'DOT-USDT', name: 'Polkadot' },
  { code: 'TON-USDT', name: 'Toncoin' },
  { code: 'SUI-USDT', name: 'Sui' },
  { code: 'LTC-USDT', name: 'Litecoin' },
  { code: 'BCH-USDT', name: 'Bitcoin Cash' },
  { code: 'NEAR-USDT', name: 'NEAR Protocol' },
  { code: 'APT-USDT', name: 'Aptos' },
  { code: 'ARB-USDT', name: 'Arbitrum' },
  { code: 'OP-USDT', name: 'Optimism' },
  { code: 'INJ-USDT', name: 'Injective' },
  { code: 'SEI-USDT', name: 'Sei' },
  { code: 'TIA-USDT', name: 'Celestia' },
  { code: 'ATOM-USDT', name: 'Cosmos' },
  { code: 'FIL-USDT', name: 'Filecoin' },
  { code: 'HBAR-USDT', name: 'Hedera' },
  { code: 'ICP-USDT', name: 'Internet Computer' },
  { code: 'RUNE-USDT', name: 'THORChain' },
  { code: 'AAVE-USDT', name: 'Aave' },
  { code: 'UNI-USDT', name: 'Uniswap' },
  { code: 'ETC-USDT', name: 'Ethereum Classic' },
  { code: 'FET-USDT', name: 'Fetch.ai' },
  { code: 'RENDER-USDT', name: 'Render' },
  { code: 'ENA-USDT', name: 'Ethena' },
  { code: 'JUP-USDT', name: 'Jupiter' },
  { code: 'WLD-USDT', name: 'Worldcoin' },
  { code: 'PEPE-USDT', name: 'Pepe' },
  { code: 'WIF-USDT', name: 'dogwifhat' },
];
