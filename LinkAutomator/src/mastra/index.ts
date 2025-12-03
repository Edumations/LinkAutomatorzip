import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import { NonRetriableError } from "inngest";
import { z } from "zod";

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";

import { registerCronTrigger } from "../triggers/cronTriggers";
import { promoPublisherAgent } from "./agents/promoPublisherAgent";
import { promoPublisherWorkflow } from "./workflows/promoPublisherWorkflow";

import { lomadeeTool } from "./tools/lomadeeTool";
import { telegramTool } from "./tools/telegramTool";
import {
  checkPostedProductsTool,
  markProductAsPostedTool,
  getRecentlyPostedProductsTool,
} from "./tools/productTrackerTool";

registerCronTrigger({
  cronExpression: process.env.SCHEDULE_CRON_EXPRESSION || "0 * * * *",
  workflow: promoPublisherWorkflow,
});

// --- ADICIONE ISTO AQUI (Lugar 1) ---
console.log("=== DIAGNÓSTICO DE INICIALIZAÇÃO ===");
console.log("O Bot está rodando!");
console.log("Chat ID configurado:", process.env.TELEGRAM_CHAT_ID);
// Mostra apenas os 5 primeiros digitos do token para segurança
console.log("Token parcial:", process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.substring(0, 5) + "..." : "NÃO ENCONTRADO");
console.log("====================================");

// Resto do seu código...

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  workflows: { promoPublisherWorkflow },
  agents: { promoPublisherAgent },
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      tools: {
        lomadeeTool,
        telegramTool,
        checkPostedProductsTool,
        markProductAsPostedTool,
        getRecentlyPostedProductsTool,
      },
    }),
  },
  bundler: {
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
    ],
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });
        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
            error,
          });
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }
      },
    ],
    apiRoutes: [
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "Mastra",
          level: "info",
        })
      : new PinoLogger({
          name: "Mastra",
          level: "info",
        }),
});

if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error(
    "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}
// --- Mantenha este código no final do arquivo para o Render não desligar o bot ---
import { createServer } from 'http';

const port = process.env.PORT || 3000;

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LinkAutomator Bot is running!');
}).listen(port, () => {
  console.log(`Render Health Check: Server listening on port ${port}`);
});

