import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// 👇 --- COLE ESTE BLOCO LOGO ABAIXO DO 'const pool' --- 👇
async function setupDatabase() {
  // Só roda se tiver URL do banco configurada
  if (!process.env.DATABASE_URL) return;
  
  console.log("🛠️ Verificando banco de dados...");
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        lomadee_product_id VARCHAR(255) UNIQUE NOT NULL,
        product_name TEXT,
        product_link TEXT,
        product_price DECIMAL(10, 2),
        posted_telegram BOOLEAN DEFAULT FALSE,
        posted_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Tabela 'posted_products' pronta para uso!");
  } catch (err) {
    console.error("❌ Erro fatal ao criar tabela:", err);
  }
}

// Executa a criação assim que este arquivo for carregado
setupDatabase();
// 👆 --------------------------------------------------- 👆
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
// --- ADICIONE ESTE BLOCO AQUI ---
      console.log("========================================");
      console.log(`🔎 [DIAGNÓSTICO CAUSA 1] A API retornou: ${products.length} produtos.`);
      if (products.length > 0) {
          console.log(`   Exemplo do 1º produto: ${products[0].name} - R$ ${products[0].price}`);
      } else {
          console.log("   ⚠️ A lista veio vazia da Lomadee!");
      }
      console.log("========================================");
      // --------------------------------
      
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

      // --- ADICIONE ESTE BLOCO AQUI ---
      console.log("========================================");
      console.log(`🔎 [DIAGNÓSTICO FILTRO] Dos produtos encontrados:`);
      console.log(`   - Já postados antes: ${alreadyPostedCount}`);
      console.log(`   - Novos para postar agora: ${newProducts.length}`);
      console.log("========================================");
      // --------------------------------


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

async function markProductAsPosted(product: Product, logger: any): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO posted_products 
       (lomadee_product_id, product_name, product_link, product_price, posted_telegram, posted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (lomadee_product_id) 
       DO UPDATE SET 
         posted_telegram = TRUE,
         posted_at = NOW()`,
      [product.id, product.name, product.link, product.price, true]
    );
    logger?.info("✅ Product marked as posted", { productId: product.id });
  } catch (error) {
    logger?.error("❌ Error marking product as posted", { error: String(error) });
  }
}

const publishProductsStep = createStep({
  id: "publish-products",
  description: "Publishes new products to Telegram",

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
    errors: z.array(z.string()),
    summary: z.string(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📤 [Step 3] Publishing products to Telegram...", {
      productsToPublish: inputData.newProducts.length,
    });

    if (!inputData.success || inputData.newProducts.length === 0) {
      logger?.info("⚠️ [Step 3] No new products to publish");
      return {
        success: true,
        publishedCount: 0,
        telegramCount: 0,
        errors: [],
        summary: "Nenhum produto novo para publicar",
      };
    }

    const results = {
      publishedCount: 0,
      telegramCount: 0,
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
        const telegramSuccess = await sendTelegramMessage(product, logger);

        if (telegramSuccess) {
          results.telegramCount++;
          results.publishedCount++;
          await markProductAsPosted(product, logger);
        }

        logger?.info(`✅ [Step 3] Product ${i + 1} processed`, {
          productId: product.id,
          telegram: telegramSuccess,
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
    errors: z.array(z.string()),
    summary: z.string(),
  }),
})
  .then(fetchProductsStep as any)
  .then(filterNewProductsStep as any)
  .then(publishProductsStep as any)
  .commit();
