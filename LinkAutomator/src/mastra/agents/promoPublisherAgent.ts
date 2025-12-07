import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai"; // Importação Padrão
import { lomadeeTool } from "../tools/lomadeeTool";
import { telegramTool } from "../tools/telegramTool";
import {
  checkPostedProductsTool,
  markProductAsPostedTool,
  getRecentlyPostedProductsTool,
} from "../tools/productTrackerTool";

export const promoPublisherAgent = new Agent({
  name: "Promo Publisher Agent",

  instructions: `
    Você é um especialista em promoções no Telegram.
    Crie legendas curtas, urgentes e vendedoras.
    Sempre inclua o preço informado.
  `,

  // Usamos openai("gpt-4o") diretamente. 
  // O Mastra vai procurar pela variável OPENAI_API_KEY que você definiu no Render.
  model: openai("gpt-4o"),

  tools: {
    lomadeeTool,
    telegramTool,
    checkPostedProductsTool,
    markProductAsPostedTool,
    getRecentlyPostedProductsTool,
  },
});
