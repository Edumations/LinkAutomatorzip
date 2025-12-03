import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  originalPrice: z.number().optional(),
  discount: z.number().optional(),
  link: z.string(),
  image: z.string().optional(),
  store: z.string().optional(),
  category: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

const fetchProductsStep = createStep({
  id: "fetch-lomadee-products",
  description: "Fetches promotional products from the Lomadee API",

  inputSchema: z.object({}),

  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🚀 [Step 1] Fetching products from Lomadee API...");

    const apiKey = process.env.LOMADEE_API_KEY;

    if (!apiKey) {
      logger?.error("❌ [Step 1] Missing LOMADEE_API_KEY");
      return {
        success: false,
        products: [],
        error: "Missing LOMADEE_API_KEY configuration",
      };
    }

    try {
      const params = new URLSearchParams({
        page: "1",
        limit: "20",
      });

      logger?.info("📡 [Step 1] Calling Lomadee API...");

      const response = await fetch(
        `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
        {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger?.error("❌ [Step 1] Lomadee API error", {
          status: response.status,
          error: errorText,
        });
        return {
          success: false,
          products: [],
          error: `Lomadee API error: ${response.status} - ${errorText}`,
        };
      }

      const data = await response.json();
      logger?.info("📦 [Step 1] Raw API response received", {
        dataKeys: Object.keys(data),
        hasData: !!data.data,
      });

      const products: Product[] = (data.data || []).map((item: any) => ({
        id: String(item.id || item.productId || Math.random().toString(36)),
        name: item.name || item.title || item.productName || "Produto sem nome",
        price: parseFloat(item.price || item.salePrice || item.priceFrom || 0),
        originalPrice: parseFloat(item.originalPrice || item.priceFrom || item.price || 0),
        discount: item.discount || item.discountPercent || 0,
        link: item.link || item.url || item.deepLink || item.affiliateLink || "",
        image: item.image || item.thumbnail || item.imageUrl || "",
        store: item.store || item.storeName || item.advertiser || "",
        category: item.category || item.categoryName || "",
      }));

      logger?.info("✅ [Step 1] Products fetched", { count: products.length });

      return {
        success: products.length > 0,
        products,
        error: products.length === 0 ? "No products found from Lomadee" : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [Step 1] Exception", { error: errorMessage });

      return {
        success: false,
        products: [],
        error: errorMessage,
      };
    }
  },
});

const filterNewProductsStep = createStep({
  id: "filter-new-products",
  description: "Filters out products that have already been posted",

  inputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    newProducts: z.array(ProductSchema),
    alreadyPostedCount: z.number(),
    error: z.string().optional(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [Step 2] Filtering new products...", {
      totalProducts: inputData.products.length,
    });

    if (!inputData.success || inputData.products.length === 0) {
      logger?.info("⚠️ [Step 2] No products to filter");
      return {
        success: false,
        newProducts: [],
        alreadyPostedCount: 0,
        error: inputData.error || "No products to filter",
      };
    }

    try {
      const productIds = inputData.products.map((p) => p.id);
      const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ");

      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        productIds
      );

      const postedIds = new Set(
        result.rows.map((row: { lomadee_product_id: string }) => row.lomadee_product_id)
      );

      const newProducts = inputData.products.filter((p) => !postedIds.has(p.id));
      const alreadyPostedCount = inputData.products.length - newProducts.length;

      logger?.info("✅ [Step 2] Filtering complete", {
        newCount: newProducts.length,
        alreadyPostedCount,
      });

      return {
        success: true,
        newProducts,
        alreadyPostedCount,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [Step 2] Error filtering products", { error: errorMessage });

      return {
        success: true,
        newProducts: inputData.products,
        alreadyPostedCount: 0,
      };
    }
  },
});

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

async function sendTelegramMessage(product: Product, logger: any): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!botToken || !channelId) {
    logger?.warn("⚠️ Telegram not configured - skipping");
    return false;
  }

  try {
    const priceFormatted = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(product.price);

    const originalPriceFormatted = product.originalPrice
      ? new Intl.NumberFormat("pt-BR", {
          style: "currency",
          currency: "BRL",
        }).format(product.originalPrice)
      : null;

    let message = `🔥 *OFERTA IMPERDÍVEL!*\n\n`;
    message += `📦 *${escapeMarkdown(product.name)}*\n\n`;

    if (product.store) {
      message += `🏪 Loja: ${escapeMarkdown(product.store)}\n`;
    }

    if (product.originalPrice && product.originalPrice > product.price) {
      message += `💰 De: ~${originalPriceFormatted}~\n`;
      message += `🏷️ *Por: ${priceFormatted}*\n`;
      if (product.discount && product.discount > 0) {
        message += `📉 Desconto: *${product.discount}% OFF*\n`;
      }
    } else {
      message += `💰 *Preço: ${priceFormatted}*\n`;
    }

    message += `\n🛒 [COMPRAR AGORA](${product.link})\n`;
    message += `\n⚡ _Corre que é por tempo limitado!_`;

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channelId,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: false,
        }),
      }
    );

    const data = await response.json();
    if (!data.ok) {
      logger?.error("❌ Telegram API error", { error: data.description });
      return false;
    }

    logger?.info("✅ Telegram message sent", { messageId: data.result.message_id });
    return true;
  } catch (error) {
    logger?.error("❌ Telegram error", { error: String(error) });
    return false;
  }
}

async function sendTwitterMessage(product: Product, logger: any): Promise<boolean> {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    logger?.warn("⚠️ Twitter not configured - skipping");
    return false;
  }

  try {
    const priceFormatted = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(product.price);

    let tweetText = `🔥 OFERTA!\n\n`;
    tweetText += `${truncateText(product.name, 80)}\n\n`;

    if (product.store) {
      tweetText += `🏪 ${product.store}\n`;
    }

    if (product.originalPrice && product.originalPrice > product.price && product.discount) {
      tweetText += `💰 ${priceFormatted} (${product.discount}% OFF)\n`;
    } else {
      tweetText += `💰 ${priceFormatted}\n`;
    }

    tweetText += `\n🛒 ${product.link}`;

    if (tweetText.length > 280) {
      tweetText = tweetText.substring(0, 277) + "...";
    }

    const oauthParams = await generateOAuthSignature({
      method: "POST",
      url: "https://api.twitter.com/2/tweets",
      apiKey,
      apiSecret,
      accessToken,
      accessTokenSecret,
    });

    const response = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: oauthParams,
      },
      body: JSON.stringify({ text: tweetText }),
    });

    const data = await response.json();

    if (!response.ok) {
      logger?.error("❌ Twitter API error", { status: response.status, error: data });
      return false;
    }

    logger?.info("✅ Tweet posted", { tweetId: data.data?.id });
    return true;
  } catch (error) {
    logger?.error("❌ Twitter error", { error: String(error) });
    return false;
  }
}

async function sendWhatsAppMessage(product: Product, logger: any): Promise<boolean> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const recipientNumber = process.env.WHATSAPP_RECIPIENT_NUMBER;

  if (!accessToken || !phoneNumberId || !recipientNumber) {
    logger?.warn("⚠️ WhatsApp not configured - skipping");
    return false;
  }

  try {
    const priceFormatted = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(product.price);

    const originalPriceFormatted = product.originalPrice
      ? new Intl.NumberFormat("pt-BR", {
          style: "currency",
          currency: "BRL",
        }).format(product.originalPrice)
      : null;

    let message = `🔥 *OFERTA IMPERDÍVEL!*\n\n`;
    message += `📦 *${product.name}*\n\n`;

    if (product.store) {
      message += `🏪 Loja: ${product.store}\n`;
    }

    if (product.originalPrice && product.originalPrice > product.price) {
      message += `💰 De: ~${originalPriceFormatted}~\n`;
      message += `🏷️ *Por: ${priceFormatted}*\n`;
      if (product.discount && product.discount > 0) {
        message += `📉 Desconto: *${product.discount}% OFF*\n`;
      }
    } else {
      message += `💰 *Preço: ${priceFormatted}*\n`;
    }

    message += `\n🛒 Compre aqui: ${product.link}\n`;
    message += `\n⚡ _Corre que é por tempo limitado!_`;

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
      logger?.error("❌ WhatsApp API error", { status: response.status, error: data.error });
      return false;
    }

    logger?.info("✅ WhatsApp message sent", { messageId: data.messages?.[0]?.id });
    return true;
  } catch (error) {
    logger?.error("❌ WhatsApp error", { error: String(error) });
    return false;
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

async function generateOAuthSignature(params: {
  method: string;
  url: string;
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}): Promise<string> {
  const { method, url, apiKey, apiSecret, accessToken, accessTokenSecret } = params;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(oauthParams[key])}`)
    .join("&");

  const signatureBaseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramString),
  ].join("&");

  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessTokenSecret)}`;

  const signature = await hmacSha1(signingKey, signatureBaseString);
  oauthParams.oauth_signature = signature;

  const authHeader =
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((key) => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
      .join(", ");

  return authHeader;
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  const base64 = Buffer.from(new Uint8Array(signature)).toString("base64");

  return base64;
}

interface PostingResults {
  telegram: boolean;
  twitter: boolean;
  whatsapp: boolean;
}

async function markProductAsPosted(product: Product, results: PostingResults, logger: any): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO posted_products 
       (lomadee_product_id, product_name, product_link, product_price, posted_telegram, posted_twitter, posted_whatsapp, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (lomadee_product_id) 
       DO UPDATE SET 
         posted_telegram = posted_products.posted_telegram OR $5,
         posted_twitter = posted_products.posted_twitter OR $6,
         posted_whatsapp = posted_products.posted_whatsapp OR $7,
         posted_at = NOW()`,
      [product.id, product.name, product.link, product.price, results.telegram, results.twitter, results.whatsapp]
    );
    logger?.info("✅ Product marked as posted", { productId: product.id, results });
  } catch (error) {
    logger?.error("❌ Error marking product as posted", { error: String(error) });
  }
}

const publishProductsStep = createStep({
  id: "publish-products",
  description: "Publishes new products to Telegram, Twitter, and WhatsApp",

  inputSchema: z.object({
    success: z.boolean(),
    newProducts: z.array(ProductSchema),
    alreadyPostedCount: z.number(),
    error: z.string().optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    publishedCount: z.number(),
    telegramCount: z.number(),
    twitterCount: z.number(),
    whatsappCount: z.number(),
    errors: z.array(z.string()),
    summary: z.string(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📤 [Step 3] Publishing products to all platforms...", {
      productsToPublish: inputData.newProducts.length,
    });

    if (!inputData.success || inputData.newProducts.length === 0) {
      logger?.info("⚠️ [Step 3] No new products to publish");
      return {
        success: true,
        publishedCount: 0,
        telegramCount: 0,
        twitterCount: 0,
        whatsappCount: 0,
        errors: [],
        summary: "Nenhum produto novo para publicar",
      };
    }

    const results = {
      publishedCount: 0,
      telegramCount: 0,
      twitterCount: 0,
      whatsappCount: 0,
      errors: [] as string[],
    };

    const maxProducts = Math.min(inputData.newProducts.length, 5);

    for (let i = 0; i < maxProducts; i++) {
      const product = inputData.newProducts[i];
      logger?.info(`📦 [Step 3] Publishing product ${i + 1}/${maxProducts}`, {
        productId: product.id,
        productName: product.name,
      });

      try {
        const [telegramSuccess, twitterSuccess, whatsappSuccess] = await Promise.all([
          sendTelegramMessage(product, logger),
          sendTwitterMessage(product, logger),
          sendWhatsAppMessage(product, logger),
        ]);

        const postingResults: PostingResults = {
          telegram: telegramSuccess,
          twitter: twitterSuccess,
          whatsapp: whatsappSuccess,
        };

        if (telegramSuccess) results.telegramCount++;
        if (twitterSuccess) results.twitterCount++;
        if (whatsappSuccess) results.whatsappCount++;

        if (telegramSuccess || twitterSuccess || whatsappSuccess) {
          results.publishedCount++;
          await markProductAsPosted(product, postingResults, logger);
        }

        logger?.info(`✅ [Step 3] Product ${i + 1} processed`, {
          productId: product.id,
          telegram: telegramSuccess,
          twitter: twitterSuccess,
          whatsapp: whatsappSuccess,
        });

        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger?.error(`❌ [Step 3] Error publishing product ${i + 1}`, {
          productId: product.id,
          error: errorMessage,
        });
        results.errors.push(`Produto ${product.id}: ${errorMessage}`);
      }
    }

    const summary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 RESUMO DA PUBLICAÇÃO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📦 Produtos processados: ${maxProducts}
✅ Produtos publicados: ${results.publishedCount}
📱 Telegram: ${results.telegramCount}
🐦 Twitter: ${results.twitterCount}
💬 WhatsApp: ${results.whatsappCount}
⚠️ Erros: ${results.errors.length}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    logger?.info(summary);

    return {
      success: true,
      ...results,
      summary,
    };
  },
});

export const promoPublisherWorkflow = createWorkflow({
  id: "promo-publisher-workflow",

  inputSchema: z.object({}) as any,

  outputSchema: z.object({
    success: z.boolean(),
    publishedCount: z.number(),
    telegramCount: z.number(),
    twitterCount: z.number(),
    whatsappCount: z.number(),
    errors: z.array(z.string()),
    summary: z.string(),
  }),
})
  .then(fetchProductsStep as any)
  .then(filterNewProductsStep as any)
  .then(publishProductsStep as any)
  .commit();
