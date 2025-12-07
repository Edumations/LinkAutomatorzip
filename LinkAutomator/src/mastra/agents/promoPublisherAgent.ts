import { Agent } from "@mastra/core/agent";
import { createOpenAI } from "@ai-sdk/openai";
import { lomadeeTool } from "../tools/lomadeeTool";
import { telegramTool } from "../tools/telegramTool";
import {
  checkPostedProductsTool,
  markProductAsPostedTool,
  getRecentlyPostedProductsTool,
} from "../tools/productTrackerTool";

// Configuração OpenAI
const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

export const promoPublisherAgent = new Agent({
  name: "Promo Publisher Agent",

  instructions: `
    Você é um especialista em Marketing Digital focado em promoções no Telegram.
    
    OBJETIVO:
    Criar legendas curtas (max 3 linhas) e urgentes para ofertas.
    
    REGRAS OBRIGATÓRIAS:
    1. Use emojis chamativos (🔥, 🚨).
    2. O PREÇO É OBRIGATÓRIO. Se o prompt disser "R$ 100", você DEVE escrever "R$ 100".
    3. Finalize com uma chamada para ação clara (ex: "Toque para comprar").
    4. NÃO coloque links no texto (eles vão no botão).
  `,

  // CORREÇÃO CRÍTICA: "openai" em vez de "openai.responses" resolve o erro vermelho dos logs
  model: openai("gpt-4o"),

  tools: {
    lomadeeTool,
    telegramTool,
    checkPostedProductsTool,
    markProductAsPostedTool,
    getRecentlyPostedProductsTool,
  },
});
