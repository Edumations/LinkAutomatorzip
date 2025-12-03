import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const whatsappTool = createTool({
  id: "whatsapp-send-message",
  description:
    "Sends a promotional message via WhatsApp Business API. Use this to share product deals and affiliate links with your WhatsApp audience.",

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
    messageId: z.string().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📱 [WhatsAppTool] Starting message send", { 
      productName: context.productName 
    });

    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const recipientNumber = process.env.WHATSAPP_RECIPIENT_NUMBER;

    if (!accessToken || !phoneNumberId || !recipientNumber) {
      logger?.warn("⚠️ [WhatsAppTool] Missing WhatsApp configuration - skipping");
      return {
        success: false,
        error: "Missing WhatsApp configuration. Required: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_RECIPIENT_NUMBER",
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

      let message = `🔥 *OFERTA IMPERDÍVEL!*\n\n`;
      message += `📦 *${context.productName}*\n\n`;

      if (context.store) {
        message += `🏪 Loja: ${context.store}\n`;
      }

      if (context.originalPrice && context.originalPrice > context.price) {
        message += `💰 De: ~${originalPriceFormatted}~\n`;
        message += `🏷️ *Por: ${priceFormatted}*\n`;
        if (context.discount && context.discount > 0) {
          message += `📉 Desconto: *${context.discount}% OFF*\n`;
        }
      } else {
        message += `💰 *Preço: ${priceFormatted}*\n`;
      }

      message += `\n🛒 Compre aqui: ${context.link}\n`;
      message += `\n⚡ _Corre que é por tempo limitado!_`;

      logger?.info("📤 [WhatsAppTool] Sending message via WhatsApp Business API", {
        phoneNumberId,
        messageLength: message.length,
      });

      const response = await fetch(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: recipientNumber,
            type: "text",
            text: {
              preview_url: true,
              body: message,
            },
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || data.error) {
        logger?.error("❌ [WhatsAppTool] WhatsApp API error", { 
          status: response.status,
          error: data.error 
        });
        return {
          success: false,
          error: `WhatsApp API error: ${data.error?.message || JSON.stringify(data)}`,
        };
      }

      const messageId = data.messages?.[0]?.id;
      logger?.info("✅ [WhatsAppTool] Message sent successfully", {
        messageId,
      });

      return {
        success: true,
        messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [WhatsAppTool] Exception occurred", { error: errorMessage });
      
      return {
        success: false,
        error: `Failed to send WhatsApp message: ${errorMessage}`,
      };
    }
  },
});

export const whatsappBroadcastTool = createTool({
  id: "whatsapp-broadcast-message",
  description:
    "Broadcasts a promotional message to a WhatsApp group or channel. Use this to share product deals with multiple recipients.",

  inputSchema: z.object({
    productName: z.string().describe("Name of the product"),
    price: z.number().describe("Current price of the product"),
    originalPrice: z.number().optional().describe("Original price before discount"),
    discount: z.number().optional().describe("Discount percentage"),
    link: z.string().describe("Affiliate link to the product"),
    image: z.string().optional().describe("Product image URL"),
    store: z.string().optional().describe("Store name"),
    groupId: z.string().optional().describe("WhatsApp group ID to broadcast to"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📱 [WhatsAppBroadcastTool] Starting broadcast", { 
      productName: context.productName 
    });

    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const groupId = context.groupId || process.env.WHATSAPP_GROUP_ID;

    if (!accessToken || !phoneNumberId) {
      logger?.warn("⚠️ [WhatsAppBroadcastTool] Missing WhatsApp configuration - skipping");
      return {
        success: false,
        error: "Missing WhatsApp configuration. Required: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID",
      };
    }

    if (!groupId) {
      logger?.warn("⚠️ [WhatsAppBroadcastTool] No group ID configured - skipping broadcast");
      return {
        success: false,
        error: "Missing WHATSAPP_GROUP_ID or groupId parameter for broadcast",
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

      let message = `🔥 *OFERTA IMPERDÍVEL!*\n\n`;
      message += `📦 *${context.productName}*\n\n`;

      if (context.store) {
        message += `🏪 Loja: ${context.store}\n`;
      }

      if (context.originalPrice && context.originalPrice > context.price) {
        message += `💰 De: ~${originalPriceFormatted}~\n`;
        message += `🏷️ *Por: ${priceFormatted}*\n`;
        if (context.discount && context.discount > 0) {
          message += `📉 Desconto: *${context.discount}% OFF*\n`;
        }
      } else {
        message += `💰 *Preço: ${priceFormatted}*\n`;
      }

      message += `\n🛒 Compre aqui: ${context.link}\n`;
      message += `\n⚡ _Corre que é por tempo limitado!_`;

      logger?.info("📤 [WhatsAppBroadcastTool] Broadcasting message", {
        phoneNumberId,
        groupId,
        messageLength: message.length,
      });

      const response = await fetch(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: groupId,
            type: "text",
            text: {
              preview_url: true,
              body: message,
            },
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || data.error) {
        logger?.error("❌ [WhatsAppBroadcastTool] WhatsApp API error", { 
          status: response.status,
          error: data.error 
        });
        return {
          success: false,
          error: `WhatsApp API error: ${data.error?.message || JSON.stringify(data)}`,
        };
      }

      const messageId = data.messages?.[0]?.id;
      logger?.info("✅ [WhatsAppBroadcastTool] Broadcast sent successfully", {
        messageId,
      });

      return {
        success: true,
        messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [WhatsAppBroadcastTool] Exception occurred", { error: errorMessage });
      
      return {
        success: false,
        error: `Failed to broadcast WhatsApp message: ${errorMessage}`,
      };
    }
  },
});
