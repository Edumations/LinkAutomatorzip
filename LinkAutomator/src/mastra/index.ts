globalThis.__MASTRA_TELEMETRY__ = true;

import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import cron from "node-cron"; 

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";

// Seus agentes e workflows
import { promoPublisherAgent } from "./agents/promoPublisherAgent";
import { promoPublisherWorkflow } from "./workflows/promoPublisherWorkflow";

// Suas ferramentas
import { lomadeeTool } from "./tools/lomadeeTool";
import { telegramTool } from "./tools/telegramTool";
import {
  checkPostedProductsTool,
  markProductAsPostedTool,
  getRecentlyPostedProductsTool,
} from "./tools/productTrackerTool";

console.log("=== INICIALIZANDO BOT NO RENDER ===");
const RENDER_PORT = parseInt(process.env.PORT || "5000");
console.log(`📡 Porta configurada: ${RENDER_PORT}`);

// Logger customizado para produção
class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;
  constructor(options: { name?: string; level?: LogLevel } = {}) {
    super(options);
    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }
  debug(msg: string, args: any = {}) { this.logger.debug(args, msg); }
  info(msg: string, args: any = {}) { this.logger.info(args, msg); }
  warn(msg: string, args: any = {}) { this.logger.warn(args, msg); }
  error(msg: string, args: any = {}) { this.logger.error(args, msg); }
}

// AQUI ESTÁ A EXPORTAÇÃO QUE ESTAVA FALTANDO
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
  server: {
    host: "0.0.0.0",
    port: RENDER_PORT, 
    apiRoutes: [
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },
      {
        path: "/",
        method: "GET",
        handler: async (c) => c.text("Mastra Bot is Running & Healthy! 🚀"),
      },
    ],
  },
  logger: new ProductionPinoLogger({ name: "Mastra", level: "info" }),
});

// Agendador Interno (Configurado para 30 minutos)
const cronExpression = process.env.SCHEDULE_CRON_EXPRESSION || "*/30 * * * *";

console.log(`⏰ Agendador iniciado: "${cronExpression}"`);

cron.schedule(cronExpression, async () => {
  console.log("🚀 [CRON] Iniciando ciclo de publicação de ofertas (20 itens)...");
  try {
    const workflow = mastra.getWorkflow("promoPublisherWorkflow");
    if (workflow) {
      const run = await workflow.createRunAsync();
      const result = await run.start({ inputData: {} });
      console.log("✅ [CRON] Workflow disparado. ID:", result.runId);
    }
  } catch (error) {
    console.error("❌ [CRON] Falha ao executar workflow:", error);
  }
});

// Teste inicial rápido (10 segundos após o boot)
setTimeout(async () => {
  console.log("⚡ [STARTUP] Executando rodada de teste inicial...");
  try {
    const workflow = mastra.getWorkflow("promoPublisherWorkflow");
    if (workflow) {
      await workflow.createRunAsync().then(run => run.start({ inputData: {} }));
    }
  } catch (e) { console.error(e); }
}, 10000);
