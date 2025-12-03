# Overview

This is a Mastra-based automation system that publishes promotional content to multiple platforms (Telegram, Twitter/X, and WhatsApp). The system uses time-based cron triggers to fetch products from the Lomadee affiliate API, filters out previously posted items, and distributes them across messaging channels. Built on the Mastra framework with Inngest for durable workflow execution, it ensures reliable, resumable processing even if failures occur.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Framework & Orchestration

**Mastra Framework (v0.20.0)**: TypeScript-first framework providing agents, tools, and workflows with structured step composition. Mastra handles multi-step process orchestration with type-safe schemas using Zod for input/output validation.

**Inngest Integration (@mastra/inngest v0.16.0)**: Provides durable workflow execution with step-by-step orchestration. Workflows can be paused, resumed, and retried without losing state. Inngest runs as a separate dev server (localhost:3000) during development and provides real-time monitoring dashboard. The integration bridges Mastra workflows to Inngest functions, enabling event-driven execution with memoization—completed steps are skipped on retry/resume.

**Workflow Execution Model**:
- Time-based triggers use cron expressions to schedule execution
- Workflows consist of steps defined with `createStep` and composed with `createWorkflow`
- Steps have explicit input/output schemas (Zod) for type safety and data validation
- `registerCronTrigger` must be called BEFORE Mastra initialization in `src/mastra/index.ts`

**Trigger System Architecture**:
- **Time-Based (Cron)**: Uses `registerCronTrigger` to schedule workflows via cron expressions (e.g., "0 * * * *" for hourly). Configured via `SCHEDULE_CRON_EXPRESSION` environment variable. Inngest evaluates the cron expression and fires events at scheduled times.
- **Webhook-Based**: Uses `registerApiRoute` to create HTTP endpoints that receive external events (Slack, Telegram, WhatsApp). Webhooks validate payloads and trigger workflows via `workflow.start()`.

## Data Persistence

**PostgreSQL**: Primary storage using `@mastra/pg` package. Configured via `DATABASE_URL` environment variable. The `sharedPostgresStorage` instance persists workflow state and product tracking data.

**Product Tracking System**: Database table `posted_products` prevents duplicate postings by storing Lomadee product IDs, names, links, prices, posting timestamps, and platform information. Tools (`checkPostedProductsTool`, `markProductAsPostedTool`, `getRecentlyPostedProductsTool`) manage this data.

**Workflow State Management**: Inngest and Mastra collaborate to persist workflow snapshots, enabling suspend/resume functionality. Snapshots capture complete execution state including step status, outputs, retry attempts, and contextual data needed for resumption.

## Logging & Observability

**Pino Logger (v9.9.4)**: Production-grade structured JSON logging with custom `ProductionPinoLogger` class extending `MastraLogger`. Configured with log levels, formatted output, timestamp formatting, and error handling. Supports both development and production environments.

**Inngest Dashboard**: Real-time workflow monitoring at http://localhost:3000 in development. Provides step-by-step visibility into workflow runs, retries, failures, and execution history with detailed event streams.

## Agent Architecture

**AI Model Integration**: Uses OpenAI models via `@ai-sdk/openai` package and OpenRouter via `@openrouter/ai-sdk-provider`. Agents are created with system instructions, model selection, and optional tools/memory configuration.

**Agent Capabilities**:
- Text generation with `.generate()` and `.generateLegacy()` methods
- Streaming responses with `.stream()` and `.streamLegacy()` methods  
- Tool integration for external API calls and custom functions
- Memory management (conversation history, semantic recall, working memory)
- Agent networks for multi-agent coordination via routing agents

**Memory System**: Optional memory using `@mastra/memory` package with LibSQL/PostgreSQL storage backends. Supports thread-scoped and resource-scoped memory, semantic recall via vector embeddings, and working memory for persistent user context.

## Tool System

**Tool Architecture**: Tools extend agent capabilities beyond text generation. Created with `createTool`, defining input/output schemas (Zod), descriptions, and execute functions. Tools can call external APIs, query databases, or run custom code.

**Tool Integration Patterns**:
- Direct tool calls from workflow steps via `execute` functions
- Tools passed to agents via `tools` configuration
- Tool streaming for progressive results using `writer` argument
- Abort signal support for canceling long-running operations

## Workflow Architecture

**Main Workflow**: `promoPublisherWorkflow` orchestrates promotional publishing:
1. Fetch products from Lomadee API (up to 20 products)
2. Check for previously posted products to avoid duplicates
3. Filter new products
4. Generate promotional messages via agents
5. Publish to multiple platforms (Telegram, Twitter, WhatsApp)
6. Mark products as posted in database

**Workflow Composition**:
- Sequential execution with `.then()`
- Parallel execution with `.parallel()`
- Conditional branching with `.when()`
- Data transformation with `.map()`
- Human-in-the-loop with `suspend()` and `resume()`

**Error Handling**: Configurable retry policies at workflow and step levels with `retryConfig` (attempts, delay). Failed steps can be automatically retried for transient errors.

## External Dependencies

**Lomadee API**: Affiliate marketing platform providing product data. Integration via `lomadeeTool` fetches promotional products with filtering, sorting, and pagination capabilities.

**Exa API (exa-js v1.8.17)**: Used for advanced search and data retrieval capabilities.

**Messaging Platforms**:
- **Telegram**: Bot integration via `TELEGRAM_BOT_TOKEN`. Webhook handling and message sending via `telegramTool`.
- **Slack (@slack/web-api v7.9.3)**: Bot integration with OAuth tokens. Webhook handling via `slackTriggers` with event filtering and message posting.
- **WhatsApp**: Business API integration via `WHATSAPP_ACCESS_TOKEN` and phone number ID. Message sending via custom client.

**AI Providers**:
- **OpenAI**: Primary LLM provider via `@ai-sdk/openai` package. Requires `OPENAI_API_KEY`.
- **OpenRouter**: Alternative provider via `@openrouter/ai-sdk-provider`. Supports 600+ models.
- **Anthropic**: Optional provider for specific agents (e.g., WhatsApp chatbot).

**Database Extensions**:
- **pgvector**: PostgreSQL extension required for semantic recall and vector similarity search in memory system.

**Development Tools**:
- **Inngest CLI (v1.11.5)**: Local dev server for testing workflows (`inngest dev -u http://localhost:5000/api/inngest --port 3000`)
- **Mastra CLI (v0.14.0)**: Development commands (`mastra dev`, `mastra build`) for running and building the application
- **TypeScript (v5.9.3)**: Static typing with ES2022 target and module resolution
- **Prettier (v3.6.2)**: Code formatting with configurable style rules

**Runtime Requirements**:
- Node.js >= 20.9.0
- PostgreSQL database with pgvector extension (when using Postgres storage)
- Environment variables for API keys, database URLs, and service tokens