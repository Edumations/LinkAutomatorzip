# Overview

This is a Mastra-based automation system built for Replit that publishes promotional content to Telegram. The system uses a time-based trigger (cron) to fetch product deals from Lomadee API and distribute them through Telegram channel.

The application is built on Mastra framework, which provides workflows and tools with durable execution via Inngest. The core automation fetches promotional products, tracks previously posted items to avoid duplicates, and publishes to Telegram.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Framework & Orchestration

**Mastra Framework (v0.20.0)**: Core framework providing workflows and tools with TypeScript-first development. Mastra handles the orchestration of multi-step processes with type-safe schemas.

**Inngest Integration**: Provides durable workflow execution with step-by-step orchestration. This ensures workflows can be paused, resumed, and retried without losing state. Inngest runs as a separate dev server (port 3000) alongside the Mastra server (port 5000) in development.

**Workflow Execution Model**: 
- Time-based triggers use cron expressions to schedule workflow execution
- Workflows consist of steps defined with `createStep` and composed with `createWorkflow`
- Steps have explicit input/output schemas (Zod) for type safety

## Data Persistence

**PostgreSQL**: Primary storage solution using the `@mastra/pg` package. Configured via `DATABASE_URL` environment variable. The `sharedPostgresStorage` instance is used for workflow state and product tracking.

**Product Tracking System**: Database table `posted_products` tracks which products have been posted to avoid duplicates. Each product is stored with its Lomadee ID, name, link, price, and posting timestamp.

**Workflow State Management**: Inngest and Mastra collaborate to persist workflow snapshots, allowing suspend/resume functionality and retry mechanisms without data loss.

## Logging & Observability

**Pino Logger**: Production-grade structured logging with custom `ProductionPinoLogger` class extending `MastraLogger`. Configured with log levels, formatted output, and error handling for both development and production environments.

**Inngest Dashboard**: Real-time monitoring of workflow execution at http://localhost:3000 in development. Provides step-by-step visibility into workflow runs, retries, and failures.

## Trigger System

**Time-Based Cron Trigger**: Uses `registerCronTrigger` to schedule the promo publisher workflow. The schedule is configurable via `SCHEDULE_CRON_EXPRESSION` environment variable (defaults to hourly: "0 * * * *").

**Trigger Registration Pattern**: Cron triggers are registered BEFORE Mastra initialization in `src/mastra/index.ts`.

**Event Flow**: Inngest evaluates cron expression → fires event → triggers workflow → workflow executes step-by-step with Inngest orchestration.

## Workflow Architecture

**Main Workflow**: `promoPublisherWorkflow` orchestrates the entire promotional publishing process:
1. Fetch products from Lomadee API (up to 20 products)
2. Check for previously posted products to avoid duplicates  
3. Publish up to 5 new products to Telegram with 2-second delay between posts

**Step Composition**: Workflow uses sequential `.then()` chaining for ordered execution. Each step has explicit input/output schemas validated by Zod.

**Rate Limiting**: Maximum 5 products per run to prevent spam and respect API limits.

# External Dependencies

## Third-Party APIs

**Lomadee API**: Product affiliate API accessed via workflow step. Provides promotional product data including prices, descriptions, and affiliate links. Requires `LOMADEE_API_KEY` environment variable.

**Telegram Bot API**: Messaging platform integration via direct API calls. Requires:
- `TELEGRAM_BOT_TOKEN`: Bot authentication token
- `TELEGRAM_CHANNEL_ID`: Target channel for posts

## Infrastructure Services

**Inngest Cloud/Dev Server**: Workflow orchestration platform running separately from Mastra server. In development, runs on localhost:3000. In production, connects to Inngest Cloud for durable execution.

**PostgreSQL Database**: Primary data store for workflow state and product tracking. Connection via `DATABASE_URL` environment variable.

## Development Tools

**TypeScript & TSX**: Type-safe development with `tsx` for running TypeScript files directly during development. ES2022 module system with bundler resolution.

**Prettier**: Code formatting configured with check and format scripts.

**Mastra CLI**: Development tooling via `mastra dev`, `mastra build` commands. Manages the build process and development server.

## Supporting Libraries

**Zod**: Schema validation for workflow inputs/outputs, tool parameters, and agent configurations.

**dotenv**: Environment variable management for configuration.

# Key Files

- `src/mastra/workflows/promoPublisherWorkflow.ts`: Main workflow with 3 steps (fetch, filter, publish)
- `src/mastra/index.ts`: Mastra configuration and cron trigger registration
- `src/triggers/cronTriggers.ts`: Cron trigger registration logic
- `tests/testCronAutomation.ts`: Manual trigger test script
