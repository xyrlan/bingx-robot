# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BingX automated grid trading bot. Full-stack Next.js app with Supabase Auth, PostgreSQL (Drizzle ORM), and Inngest workflow orchestration. Users connect BingX API keys, configure grid trading bots, and the system automatically places/manages orders via a cron job.

## Commands

```bash
# Development
npm run dev              # Next.js dev server
npm run worker:dev       # Inngest Connect worker with hot reload
npm run inngest          # Local Inngest dev server (needs dev server running)

# Build & Production
npm run build            # Production build
npm run start            # Production server
npm run worker           # Production Inngest worker

# Database (uses Bun via bunx)
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Run migrations
npm run db:push          # Push schema directly (dev only)

# Linting
npm run lint             # ESLint 9
```

## Architecture

### Tech Stack
- **Framework**: Next.js 16 (App Router) with TypeScript
- **UI**: React 19, Tailwind CSS v4, HeroUI v3 components
- **Database**: PostgreSQL via Supabase, Drizzle ORM
- **Auth**: Supabase Auth (email/password)
- **Orchestration**: Inngest (cron jobs, event-driven functions)
- **Exchange**: BingX perpetual futures API
- **i18n**: next-intl
- **Package manager**: Bun (bun.lock)

### Path Alias
`@/*` maps to `src/*` (configured in tsconfig.json).

### Key Directories
- `src/services/bingx.service.ts` — Core trading logic (~1000 lines): bot CRUD, order placement, grid level management, P&L calculation
- `src/lib/bingx/` — BingX API client with HMAC-SHA256 signing and AES-256-GCM encryption for stored secrets
- `src/inngest/functions/trading-bot-watch.ts` — Cron job running every 5 minutes: checks prices, places missing entry orders, attaches take-profit orders
- `src/db/schema.ts` — Drizzle schema: users, profiles, bingxApiKeys, tradingBots, gridLevels
- `src/app/api/bingx/` — REST API routes for bot operations, balance, keys, symbol config
- `src/components/trading/` — Trading UI components (bot config, bot list, balance display)
- `src/worker.ts` — Inngest Connect worker entry point for Railway/Render deployment

### Trading Bot Flow
1. User stores encrypted BingX API keys → `bingxApiKeys` table
2. User creates bot config (symbol, price range, grid count, leverage) → `tradingBots` + `gridLevels` tables
3. User starts bot → status changes to RUNNING, triggers Inngest event
4. Cron job (every 5 min): for each RUNNING bot, places LIMIT or TRIGGER_LIMIT entry orders at grid levels, attaches TAKE_PROFIT_MARKET orders to filled positions
5. Stop bot: cancels entry orders only, leaves positions & take-profit orders active ("Let it Ride")

### Deployment
- **Vercel**: Hosts Next.js app + API routes
- **Railway/Render**: Runs Inngest Connect worker to avoid Vercel's execution limits
- Set `INNGEST_USE_CONNECT=1` on Vercel when using external worker

## Important Patterns

- **BigInt precision**: Exchange order IDs are large numbers. Use `json-bigint` for parsing and `toSafeIdString()` for converting IDs — never use standard `JSON.parse` for BingX responses.
- **Price precision**: `toPrecision()` rounds DOWN for prices, `toQuantityPrecision()` rounds UP for quantities to meet minimum USDT requirements.
- **API rate limiting**: 400ms delays between BingX API calls in batch operations. Contract info cached for 10 minutes.
- **Encryption**: BingX secret keys encrypted with AES-256-GCM using `ENCRYPTION_KEY` env var before storage.
- **Inngest concurrency**: Bot watch limited to 1 concurrent run; worker limited to 5 concurrent functions.

## Environment Variables

See `.env.example`. Key required vars:
- `DATABASE_URL` / `DIRECT_URL` — Supabase PostgreSQL connections
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase client config
- `ENCRYPTION_KEY` — 32-byte key for AES-256-GCM encryption of API secrets
- `INNGEST_SIGNING_KEY` / `INNGEST_EVENT_KEY` — Inngest auth (production)
