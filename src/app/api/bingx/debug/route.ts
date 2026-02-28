import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getBingxClient } from '@/services/bingx.service';

/**
 * Debug endpoint to diagnose BingX signature issues.
 * Runs in the same context as balance API. Tests:
 * 1. Balance (no params)
 * 2. openOrders with {} (no symbol)
 * 3. openOrders with { symbol: "BTC-USDT" }
 */
export async function GET() {
  try {
    const user = await requireAuth();
    const client = await getBingxClient(user.id);

    if (!client) {
      return NextResponse.json(
        { error: 'BingX API keys not configured. Connect your keys first.' },
        { status: 400 }
      );
    }

    const results: Record<string, { success: boolean; error?: string }> = {};

    // 1. Balance (no params)
    try {
      await client.get('/openApi/swap/v2/user/balance');
      results.balance = { success: true };
    } catch (err) {
      results.balance = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 2. openOrders with {} (no params)
    try {
      await client.get('/openApi/swap/v2/trade/openOrders', {});
      results.openOrdersNoSymbol = { success: true };
    } catch (err) {
      results.openOrdersNoSymbol = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 3. openOrders with { symbol: "BTC-USDT" }
    try {
      await client.get('/openApi/swap/v2/trade/openOrders', { symbol: 'BTC-USDT' });
      results.openOrdersWithSymbol = { success: true };
    } catch (err) {
      results.openOrdersWithSymbol = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return NextResponse.json({
      userId: user.id,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Debug request failed';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
