// Adicione isso na primeira linha
globalThis.__MASTRA_TELEMETRY__ = true;

import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import { NonRetriableError } from "inngest";
import { z } from "zod";
// Importar cron nativo para não depender do Inngest Cloud
import cron from "node-cron"; 

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";

// Importar workflows e agentes
import { promoPublisherAgent } from "./agents/promoPublisherAgent";
import { promoPublisherWorkflow } from "./workflows/promoPublisherWorkflow";

// Importar ferramentas
import { lomadeeTool } from "./tools/lomadeeTool";
import { telegramTool } from "./tools/telegramTool";
import {
  checkPostedProductsTool,
  markProductAsPostedTool,
  getRecentlyPostedProductsTool,
} from "./tools/productTrackerTool";

// --- DIAGNÓSTICO INICIAL ---
console.log("=== INICIANDO MASTRA NO RENDER ===");
console.log("Chat ID:", process.env.TELEGRAM_CHAT_ID ? "Configurado" : "FALTANDO");
console.log("Bot Token:", process.env.TELEGRAM_BOT_TOKEN ? "Configurado" : "FALTANDO");
console.log("Porta do Render:", process.env.PORT || "Não definida (usando 5000)");

// Configuração do Logger
class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;
  constructor(options: { name?: string; level?: LogLevel; } = {}) {
    super(options);
    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }
  debug(message: string, args: Record<string, any> = {}): void { this.logger.debug(args, message); }
  info(message: string, args: Record<string, any> = {}): void { this.logger.info(args, message); }
  warn(message: string, args: Record<string, any> = {}): void { this.logger.warn(args, message); }
  error(message: string, args: Record<string, any> = {}): void { this.logger.error(args, message); }
}

// Inicialização do Mastra
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
    // CORREÇÃO CRÍTICA 1: Usar a porta que o Render fornece
    port: parseInt(process.env.PORT || "5000"), 
    apiRoutes: [
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },
      // Rota simples para o Health Check do Render não falhar
      {
        path: "/",
        method: "GET",
        handler: async (c) => c.text("Mastra Bot is Running! 🚀"),
      }
    ],
  },
  logger: new ProductionPinoLogger({ name: "Mastra", level: "info" }),
});

// CORREÇÃO CRÍTICA 2: Agendador Interno (Substitui o Inngest Cron)
// Isso garante que o bot rode sozinho sem precisar de gatilhos externos
const cronExpression = process.env.SCHEDULE_CRON_EXPRESSION || "*/30 * * * *"; // A cada 30 min por padrão

console.log(`⏰ Configurando agendamento interno: ${cronExpression}`);

// Instale node-cron se não tiver: npm install node-cron @types/node-cron
cron.schedule(cronExpression, async () => {
  console.log("🚀 [CRON INTERNO] Disparando workflow de promoções...");
  try {
    const workflow = mastra.getWorkflow("promoPublisherWorkflow");
    if (workflow) {
      // Inicia o workflow manualmente
      const run = await workflow.createRunAsync();
      const result = await run.start({ inputData: {} });
      console.log("✅ Workflow iniciado com sucesso:", result.runId);
    } else {
      console.error("❌ Workflow não encontrado!");
    }
  } catch (error) {
    console.error("❌ Erro ao disparar workflow:", error);
  }
});

// Disparo imediato ao iniciar (para você ver funcionando logo no deploy)
setTimeout(async () => {
  console.log("⚡ [STARTUP] Executando verificação inicial...");
  const workflow = mastra.getWorkflow("promoPublisherWorkflow");
  if (workflow) {
    const run = await workflow.createRunAsync();
    run.start({ inputData: {} }).catch(err => console.error("Erro no startup:", err));
  }
}, 10000); // Roda 10 segundos após o boot
