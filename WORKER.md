# Inngest Connect Worker

The trading bot cron runs on Vercel by default. To avoid **Fast Origin Transfer** (CDN to Compute) limits, you can run the worker on Railway, Render, or Fly.io using Inngest Connect.

## Quick Start

```bash
# Local (with INNGEST_DEV=1 and inngest-cli)
INNGEST_DEV=1 bun run worker
```

## Deployment

### 1. Set Vercel env (when using worker)

On your Vercel project, add:

```
INNGEST_USE_CONNECT=1
```

This stops registering `trading-bot-watch` from Vercel so the worker is the only executor.

### 2. Deploy worker to Railway

1. Create a new Railway project
2. Add a service from this repo
3. Set **Start Command**: `bun run worker` (or `npx tsx src/worker.ts`)
4. Add env vars:
   - `DATABASE_URL` (same as Vercel)
   - `INNGEST_SIGNING_KEY` (from Inngest dashboard)
   - `INNGEST_EVENT_KEY` (from Inngest dashboard, for sending events)
   - Any other vars used by `bingx.service` (e.g. encryption keys)

### 3. Deploy worker to Render

1. New Web Service from repo
2. Build: `bun install` (or `npm install`)
3. Start: `bun run worker` (or `npx tsx src/worker.ts`)
4. Add the same env vars as above

### 4. Health check

The worker exposes `/ready` and `/health` for load balancers. Returns 200 when connected to Inngest.

## Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `INNGEST_SIGNING_KEY` | Yes (prod) | From Inngest dashboard |
| `INNGEST_EVENT_KEY` | Yes (prod) | From Inngest dashboard |
| `INNGEST_DEV` | No | Set to `1` for local dev with inngest-cli |
| `WORKER_PORT` | No | HTTP port (default 8080) |
