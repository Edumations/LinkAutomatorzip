// MUDANÇA CRÍTICA: Importamos do core, não da pasta ../inngest
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Configuração da Tabela (Mantida)
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
    console.log("✅ Tabela 'posted_products' pronta para uso!");
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
        return {
          success: false,
          products: [],
          error: `Lomadee API error: ${response.status} - ${errorText}`,
        };
      }

      const data = await response.json();
      
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

      // Logs de diagnóstico
      console.log("========================================");
      console.log(`🔎 [DIAGNÓSTICO] A API retornou: ${products.length} produtos.`);
      console.log("========================================");
      
      return {
        success: products.length > 0,
        products,
        error: products.length === 0 ? "No products found from Lomadee" : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        products: [],
        error: errorMessage,
      };
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

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    
    if (!inputData.success || inputData.products.length === 0) {
      return {
        success: false,
        newProducts: [],
        alreadyPostedCount: 0,
        error: inputData.error || "No products to filter",
      };
    }

    try {
      const productIds = inputData.products.map((p) => p.id);
      
      // Se não houver produtos para verificar, retorna vazio
      if (productIds.length === 0) {
         return { success: true, newProducts: [], alreadyPostedCount: 0 };
      }

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

      console.log(`🔎 [FILTRO] Novos: ${newProducts.length} | Já postados: ${alreadyPostedCount}`);

      return {
        success: true,
        newProducts,
        alreadyPostedCount,
      };
    } catch (error) {
      logger?.error("❌ [Step 2] Error filtering products", { error: String(error) });
      // Em caso de erro no banco, tenta enviar tudo (fail-open) ou nada
      return {
        success: true,
        newProducts: inputData.products,
        alreadyPostedCount: 0,
      };
    }
  },
});

function escapeMarkdown(text: string): string {
  // Escapa caracteres reservados do MarkdownV2 se necessário, 
  // mas aqui estamos usando Markdown simples ou HTML é mais seguro.
  // Para Markdown "clássico", chars como * e _ precisam de atenção.
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

async function sendTelegramMessage(product: Product, logger: any): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!botToken || !channelId) {
    logger?.warn("⚠️ Telegram not configured");
    return false;
  }

  try {
    const priceFormatted = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(product.price);

    let message = `🔥 *OFERTA IMPERDÍVEL!*\n\n`;
    message += `📦 *${product.name}*\n\n`; // Removido escapeMarkdown temporariamente para evitar double-escaping se não usar V2

    if (product.store) message += `🏪 Loja: ${product.store}\n`;

    if (product.originalPrice && product.originalPrice > product.price) {
      const original = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.originalPrice);
      message += `💰 De: ~${original}~\n`;
      message += `🏷️ *Por: ${priceFormatted}*\n`;
    } else {
      message += `💰 *Preço: ${priceFormatted}*\n`;
    }

    message += `\n🛒 [COMPRAR AGORA](${product.link})\n`;

    // Envio com foto ou texto
    const endpoint = product.image ? "sendPhoto" : "sendMessage";
    const body: any = {
      chat_id: channelId,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    };

    if (product.image) {
      body.photo = product.image;
      body.caption = message;
    } else {
      body.text = message;
    }

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();
    if (!data.ok) {
      console.error(`❌ Erro Telegram: ${data.description}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("❌ Exceção Telegram:", error);
    return false;
  }
}

async function markProductAsPosted(product: Product, logger: any): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO posted_products 
       (lomadee_product_id, product_name, product_link, product_price, posted_telegram, posted_at)
       VALUES ($1, $2, $3,
