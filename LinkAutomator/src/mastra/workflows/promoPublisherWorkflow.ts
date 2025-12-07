import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

// Configuração do Banco de Dados
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Inicialização da Tabela
async function setupDatabase() {
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
    console.log("✅ Tabela 'posted_products' pronta!");
  } catch (err) {
    console.error("❌ Erro fatal ao criar tabela:", err);
  }
}

setupDatabase();

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

// Passo 1: Buscar Produtos
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
    logger?.info("🚀 [Step 1] Buscando produtos na Lomadee...");

    const apiKey = process.env.LOMADEE_API_KEY;

    if (!apiKey) {
      return { success: false, products: [], error: "Missing LOMADEE_API_KEY" };
    }

    try {
      const params = new URLSearchParams({ page: "1", limit: "20" });
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
        return { success: false, products: [], error: `API Error: ${response.status}` };
      }

      const data = await response.json();
      
      const products: Product[] = (data.data || []).map((item: any) => ({
        id: String(item.id || item.productId || Math.random().toString(36)),
        name: item.name || item.productName || "Produto sem nome",
        price: parseFloat(item.price || item.salePrice || 0),
        originalPrice: parseFloat(item.originalPrice || item.price || 0),
        discount: item.discount || 0,
        link: item.link || item.url || "",
        image: item.image || item.thumbnail || "",
        store: item.store || item.storeName || "",
        category: item.category || "",
      }));

      console.log(`🔎 [API] Retornou ${products.length} produtos.`);
      
      return {
        success: products.length > 0,
        products,
      };
    } catch (error) {
      return { success: false, products: [], error: String(error) };
    }
  },
});

// Passo 2: Filtrar Produtos
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

  execute: async ({ inputData }) => {
    if (!inputData.success || inputData.products.length === 0) {
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }

    try {
      const productIds = inputData.products.map((p) => p.id);
      if (productIds.length === 0) return { success: true, newProducts: [], alreadyPostedCount: 0 };

      const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ");
      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        productIds
      );

      const postedIds = new Set(result.rows.map((row: any) => row.lomadee_product_id));
      const newProducts = inputData.products.filter((p) => !postedIds.has(p.id));
      const alreadyPostedCount = inputData.products.length - newProducts.length;

      console.log(`🔎 [FILTRO] Novos: ${newProducts.length} | Repetidos: ${alreadyPostedCount}`);

      return { success: true, newProducts, alreadyPostedCount };
    } catch (error) {
      console.error("Erro no filtro:", error);
      // Fail-safe: retorna lista vazia em caso de erro no banco
      return { success: false, newProducts: [], alreadyPostedCount: 0, error: String(error) };
    }
  },
});

// Funções Auxiliares de Envio
async function sendTelegramMessage(product: Product, logger: any): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!botToken || !channelId) return false;

  try {
    const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);
    
    let message = "🔥 *OFERTA IMPERDÍVEL!*\n\n";
    message += `📦 *${product.name}*\n\n`;
    
    if (product.store) message += `🏪 Loja: ${product.store}\n`;
    
    if (product.originalPrice && product.originalPrice > product.price) {
      const original = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.originalPrice);
      message += `💰 De: ~${original}~\n`;
      message += `🏷️ *Por: ${priceFormatted}*\n`;
    } else {
      message += `💰 *Preço: ${priceFormatted}*\n`;
    }
    
    message += `\n🛒 [COMPRAR AGORA](${product.link})\n`;

    const endpoint = product.image ? "sendPhoto" : "sendMessage";
    const body: any = {
      chat_id: channelId,
      parse_mode: "Markdown",
      disable_web_page_preview: false
    };

    if (product.image) {
      body.photo = product.image;
      body.caption = message;
    } else {
      body.text = message;
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    return response.ok;
  } catch (error) {
    console.error("Erro Telegram:", error);
    return false;
  }
}

async function markProductAsPosted(product: Product): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO posted_products 
       (lomadee_product_id, product_name, product_link, product_price, posted_telegram, posted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (lomadee_product_id) DO UPDATE SET posted_telegram = TRUE, posted_at = NOW()`,
      [product.id, product.name, product.link, product.price, true]
    );
  } catch (err) {
    console.error("Erro ao salvar no banco:", err);
  }
}

// Passo 3: Publicar
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
    summary: z.string(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    
    if (!inputData.success || inputData.newProducts.length === 0) {
      return { success: true, publishedCount: 0, summary: "Nenhum produto novo." };
    }

    let publishedCount = 0;
    const maxProducts = Math.min(inputData.newProducts.length, 5);

    for (let i = 0; i < maxProducts; i++) {
      const product = inputData.newProducts[i];
      const sent = await sendTelegramMessage(product, logger);
      
      if (sent) {
        await markProductAsPosted(product);
        publishedCount++;
        console.log(`✅ Enviado: ${product.name}`);
        // Delay para evitar spam
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    return {
      success: true,
      publishedCount,
      summary: `Publicados ${publishedCount} produtos com sucesso.`,
    };
  },
});

export const promoPublisherWorkflow = createWorkflow({
  id: "promo-publisher-workflow",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    publishedCount: z.number(),
    summary: z.string(),
  }),
})
  .then(fetchProductsStep)
  .then(filterNewProductsStep)
  .then(publishProductsStep)
  .commit();
