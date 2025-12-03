import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const telegramTool = createTool({
  id: "telegram-send-message",
  description:
    "Sends a promotional message to a Telegram channel. Use this to share product deals and affiliate links with your Telegram audience.",

  inputSchema: z.object({
    productName: z.string().describe("Name of the product"),
    price: z.number().describe("Current price of the product"),
    originalPrice: z.number().optional().describe("Original price before discount"),
    discount: z.number().optional().describe("Discount percentage"),
    link: z.string().describe("Affiliate link to the product"),
    image: z.string().optional().describe("Product image URL"),
    store: z.string().optional().describe("Store name"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.number().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [TelegramTool] Starting message send", { 
      productName: context.productName 
    });

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const channelId = process.env.TELEGRAM_CHANNEL_ID;

    if (!botToken || !channelId) {
      logger?.error("❌ [TelegramTool] Missing configuration", {
        hasBotToken: !!botToken,
        hasChannelId: !!channelId,
      });
      return {
        success: false,
        error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID configuration",
      };
    }

    try {
      const priceFormatted = new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(context.price);

      const originalPriceFormatted = context.originalPrice
        ? new Intl.NumberFormat("pt-BR", {
            style: "currency",
            currency: "BRL",
          }).format(context.originalPrice)
        : null;

      let caption = `🔥 *OFERTA IMPERDÍVEL!*\n\n`;
      caption += `📦 *${escapeMarkdown(context.productName)}*\n\n`;

      if (context.store) {
        caption += `🏪 Loja: ${escapeMarkdown(context.store)}\n`;
      }

      if (context.originalPrice && context.originalPrice > context.price) {
        caption += `💰 De: ~${originalPriceFormatted}~\n`;
        caption += `🏷️ *Por: ${priceFormatted}*\n`;
        if (context.discount && context.discount > 0) {
          caption += `📉 Desconto: *${context.discount}% OFF*\n`;
        }
      } else {
        caption += `💰 *Preço: ${priceFormatted}*\n`;
      }

      caption += `\n🛒 [COMPRAR AGORA](${context.link})\n`;
      caption += `\n⚡ _Corre que é por tempo limitado!_`;

      logger?.info("📤 [TelegramTool] Sending message to Telegram", {
        channelId,
        hasImage: !!context.image
      });

      // Se tiver imagem, usa sendPhoto. Se não, usa sendMessage.
      const method = context.image ? "sendPhoto" : "sendMessage";
      
      const body: any = {
        chat_id: channelId,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: false,
      };

      if (context.image) {
          body.photo = context.image;
          body.caption = caption;
      } else {
          body.text = caption;
      }

      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/${method}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
      
      // ... o resto do código continua igual (verificação de erro e retorno)
// ... código que busca produtos ...

// --- ADICIONE ISTO AQUI (Lugar 2) ---
console.log("Tentando enviar mensagem agora...");
console.log("Existe token neste momento?", process.env.TELEGRAM_BOT_TOKEN ? "Sim" : "Não");

// A linha que envia a mensagem vem logo abaixo (exemplo):
// await bot.telegram.sendMessage(chatId, texto);
      const data = await response.json();

      if (!data.ok) {
        logger?.error("❌ [TelegramTool] Telegram API error", { 
          error: data.description 
        });
        return {
          success: false,
          error: `Telegram API error: ${data.description}`,
        };
      }

      logger?.info("✅ [TelegramTool] Message sent successfully", {
        messageId: data.result.message_id,
      });

      return {
        success: true,
        messageId: data.result.message_id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [TelegramTool] Exception occurred", { error: errorMessage });
      
      return {
        success: false,
        error: `Failed to send Telegram message: ${errorMessage}`,
      };
    }
  },
});

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}
