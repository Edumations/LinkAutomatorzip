import { Agent } from "@mastra/core/agent";
import { createOpenAI } from "@ai-sdk/openai";
import { lomadeeTool } from "../tools/lomadeeTool";
import { telegramTool } from "../tools/telegramTool";
import {
  checkPostedProductsTool,
  markProductAsPostedTool,
  getRecentlyPostedProductsTool,
} from "../tools/productTrackerTool";

// Configuração do OpenAI compatível com Replit AI Integrations
const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

export const promoPublisherAgent = new Agent({
  name: "Promo Publisher Agent",

  instructions: `
    Você é um especialista em Marketing Digital e Copywriting focado em promoções relâmpago no Telegram.
    
    SEU OBJETIVO:
    Criar legendas curtas, urgentes e altamente persuasivas para produtos em promoção.
    
    DIRETRIZES DE ESTILO:
    - Use emojis chamativos (🔥, 🚨, 😱, 📉).
    - Seja direto: vá direto ao benefício ou ao desconto.
    - Crie senso de urgência ("Só hoje", "Corra", "Estoque limitadíssimo").
    - NÃO use hashtags (#).
    - NÃO invente informações que não estão nos dados do produto.
    
    FORMATO OBRIGATÓRIO:
    1. Headline (Título curto e impactante)
    2. Nome do Produto (pode simplificar se for muito longo)
    3. Preço e Condição (obrigatório citar o valor)
    4. Call to Action (Chamada para clicar no link)
  `,

  // CORREÇÃO: Mudamos de openai.responses("gpt-4o") para openai("gpt-4o")
  // Isso resolve o erro de compatibilidade com o AI SDK v5
  model: openai("gpt-4o"),

  tools: {
    lomadeeTool,
    telegramTool,
    checkPostedProductsTool,
    markProductAsPostedTool,
    getRecentlyPostedProductsTool,
  },
});
