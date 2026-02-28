# Next.js + Supabase Template

A generic template repository with Next.js 16, Supabase Auth, Drizzle ORM, and PostgreSQL.

## Stack

- **Framework:** Next.js 16 (App Router)
- **Database:** PostgreSQL + Drizzle ORM
- **Auth:** Supabase (email/password)
- **UI:** HeroUI v3, Tailwind CSS v4
- **i18n:** next-intl

## Database Schema

- **users** – Identity (sync with Supabase Auth)
- **profiles** – Extended user data (1:1 with users)

## Getting Started

### 1. Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."
NEXT_PUBLIC_SUPABASE_URL="https://your-project.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
```

### 2. Database Migrations

```bash
bun run db:generate   # Generate migrations from schema
bun run db:migrate    # Run migrations (or use db:push for dev)
```

### 3. Run Development Server

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
src/
├── app/
│   ├── (auth)/          # Login, register, verify-email
│   ├── (dashboard)/     # Protected dashboard
│   └── api/auth/        # Auth callback
├── db/
│   └── schema.ts       # Drizzle schema
├── services/
│   ├── auth.service.ts
│   └── user-setup.service.ts
└── lib/
    └── supabase/       # Supabase client (server/client)
```

## Using as Template

1. Use GitHub "Use this template" or clone the repo
2. Update environment variables
3. Run migrations against your database
4. Configure Supabase Auth (email provider, redirect URLs)
5. Customize schema and features as needed
