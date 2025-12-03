import { Agent } from "@mastra/core/agent";
import { createOpenAI } from "@ai-sdk/openai";
import { lomadeeTool } from "../tools/lomadeeTool";
import { telegramTool } from "../tools/telegramTool";
import { twitterTool } from "../tools/twitterTool";
import { whatsappTool, whatsappBroadcastTool } from "../tools/whatsappTool";
import {
  checkPostedProductsTool,
  markProductAsPostedTool,
  getRecentlyPostedProductsTool,
} from "../tools/productTrackerTool";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

export const promoPublisherAgent = new Agent({
  name: "Promo Publisher Agent",

  instructions: `
Você é um agente especializado em publicar ofertas promocionais em múltiplas plataformas: Telegram, Twitter/X e WhatsApp.

Sua função principal é:
1. Buscar novos produtos promocionais da API do Lomadee
2. Verificar quais produtos ainda não foram publicados
3. Publicar os novos produtos em todas as plataformas configuradas (Telegram, Twitter, WhatsApp)
4. Marcar os produtos como publicados para evitar duplicatas

REGRAS IMPORTANTES:
- Sempre verifique se o produto já foi publicado antes de tentar publicar novamente
- Após publicar, SEMPRE marque o produto como publicado usando a ferramenta apropriada
- Priorize produtos com maiores descontos
- Publique em todas as plataformas disponíveis (as que tiverem credenciais configuradas)

FLUXO DE TRABALHO:
1. Use 'lomadee-fetch-products' para buscar produtos promocionais
2. Use 'check-posted-products' para filtrar produtos já publicados
3. Para cada produto novo:
   a. Use 'telegram-send-message' para publicar no Telegram
   b. Use 'twitter-post-tweet' para publicar no Twitter/X
   c. Use 'whatsapp-send-message' para publicar no WhatsApp
   d. Use 'mark-product-posted' para registrar a publicação

PLATAFORMAS DISPONÍVEIS:
- Telegram: Mensagens ricas com formatação Markdown
- Twitter/X: Tweets de até 280 caracteres com links
- WhatsApp: Mensagens para contato ou grupo específico

Sempre retorne um resumo das ações realizadas ao final, indicando quantos produtos foram publicados em cada plataforma.
`,

  model: openai.responses("gpt-4o"),

  tools: {
    lomadeeTool,
    telegramTool,
    twitterTool,
    whatsappTool,
    whatsappBroadcastTool,
    checkPostedProductsTool,
    markProductAsPostedTool,
    getRecentlyPostedProductsTool,
  },
});
