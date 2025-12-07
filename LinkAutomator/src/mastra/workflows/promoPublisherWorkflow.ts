import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
    await client.query(`
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
    client.release();
  } catch (err) {
    console.error("❌ Erro DB:", err);
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
  generatedMessage: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

// Lista de categorias para garantir variedade a cada execução
const KEYWORDS = [
  "Smart TV", "Smartphone", "Geladeira", "Notebook", "Air Fryer", 
  "Ar Condicionado", "Monitor Gamer", "Cadeira Gamer", "Lavadora", 
  "Fogão", "Microondas", "Iphone 15", "Samsung Galaxy", "PlayStation 5",
  "Fone Bluetooth", "Tablet", "Ventilador", "Sofá", "Guarda Roupa"
];

function safeParseFloat(value: any): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  let str = String(value);
  // Se for formato brasileiro "1.200,50"
  if (str.includes(",") && str.includes(".")) str = str.replace(/\./g, "");
  str = str.replace(",", ".");
  str = str.replace(/[^0-9.]/g, "");
  return parseFloat(str) || 0;
}

function getStoreFromLink(link: string, fallback: string): string {
  if (!link) return fallback;
  const lower = link.toLowerCase();
  
  const stores: Record<string, string> = {
    "amazon": "Amazon", "magalu": "Magalu", "magazineluiza": "Magalu",
    "shopee": "Shopee", "mercadolivre": "Mercado Livre", "casasbahia": "Casas Bahia",
    "americanas": "Americanas", "girafa": "Girafa", "fastshop": "Fast Shop",
    "ponto": "Ponto Frio", "extra": "Extra", "kabum": "KaBuM!",
    "carrefour": "Carrefour", "friopecas": "FrioPeças", "frio peças": "FrioPeças",
    "brastemp": "Brastemp", "consul": "Consul", "electrolux": "Electrolux",
    "nike": "Nike", "adidas": "Adidas", "netshoes": "Netshoes"
  };

  for (const key in stores) {
    if (lower.includes(key)) return stores[key];
  }
  return fallback;
}

// Passo 1: Buscar Produtos (POR PALAVRA-CHAVE)
const fetchProductsStep = createStep({
  id: "fetch-lomadee-products",
  description: "Fetches products",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),
  execute: async ({ mastra }) => {
    const apiKey = process.env.LOMADEE_API_KEY;
    if (!apiKey) return { success: false, products: [], error: "Missing Key" };

    try {
      // Sorteia uma categoria para esta rodada
      const randomKeyword = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
      console.log(`🚀 [Passo 1] Buscando ofertas de: "${randomKeyword}"`);

      const params = new URLSearchParams({ 
        keyword: randomKeyword,
        sort: "discount", // Volta para desconto, mas focado na categoria
        limit: "50"
      });

      const response = await fetch(
        `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
        {
          method: "GET",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        }
      );

      if (!response.ok) return { success: false, products: [], error: `API Error` };

      const data = await response.json();
      
      const products: Product[] = (data.data || []).map((item: any) => {
        const rawLink = item.link || item.url || "";
        const storeName = item.store?.name || getStoreFromLink(rawLink, "Loja Parceira");
        
        // Tenta pegar o preço de todos os lugares possíveis
        const rawPrice = item.price || item.salePrice || item.priceMin || item.priceMax || 0;
        const finalPrice = safeParseFloat(rawPrice);

        // DEBUG SE O PREÇO FOR ZERO
        if (finalPrice === 0) {
           console.log(`⚠️ Produto sem preço (${item.name || item.productName}):`, JSON.stringify(item));
        }

        return {
          id: String(item.id || item.productId || Math.random().toString(36)),
          name: item.name || item.productName || "Produto Oferta",
          price: finalPrice,
          originalPrice: safeParseFloat(item.originalPrice || item.priceFrom || item.priceMax),
          discount: item.discount || 0,
          link: rawLink,
          image: item.image || item.thumbnail || "",
          store: storeName,
          category: item.category?.name || item.categoryName || randomKeyword, // Usa a keyword se não tiver cat
          generatedMessage: "",
        };
      });

      // Filtra produtos sem preço válido
      const validProducts = products.filter(p => p.price > 0.01);
      
      console.log(`✅ [Passo 1] Encontrados: ${validProducts.length} produtos de ${randomKeyword}`);
      return { success: true, products: validProducts };
    } catch (error) {
      console.error("Erro fetch:", error);
      return { success: false, products: [], error: String(error) };
    }
  },
});

// Passo 2: Filtrar
const filterNewProductsStep = createStep({
  id: "filter-new-products",
  description: "Filters products",
  inputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    newProducts: z.array(ProductSchema),
    alreadyPostedCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    console.log("🚀 [Passo 2] Filtrando novos...");
    if (!inputData.success || inputData.products.length === 0) {
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }

    try {
      const productIds = inputData.products.map((p) => p.id);
      const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ");
      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        productIds
      );

      const postedIds = new Set(result.rows.map((row: any) => row.lomadee_product_id));
      const available = inputData.products.filter((p) => !postedIds.has(p.id));
      
      // Como já buscamos por categoria específica, podemos pegar os Top 20 disponíveis
      // A diversidade virá da rotação de categorias a cada hora
      const selected = available.slice(0, 20);

      console.log(`✅ [Passo 2] ${selected.length} produtos novos para postar.`);
      return { success: true, newProducts: selected, alreadyPostedCount: result.rowCount || 0 };
    } catch {
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }
  },
});

// Passo 3: IA
const generateCopyStep = createStep({
  id: "generate-copy",
  description: "AI Copywriting",
  inputSchema: z.object({
    success: z.boolean(),
    newProducts: z.array(ProductSchema),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    enrichedProducts: z.array(ProductSchema),
  }),
  execute: async ({ inputData, mastra }) => {
    console.log(`🚀 [Passo 3] Criando textos para ${inputData.newProducts.length} produtos...`);
    if (!inputData.success || inputData.newProducts.length === 0) {
      return { success: true, enrichedProducts: [] };
    }

    const agent = mastra?.getAgent("promoPublisherAgent");
    const enrichedProducts = [...inputData.newProducts];

    // Processamento em lote para agilizar
    const batchSize = 5;
    for (let i = 0; i < enrichedProducts.length; i += batchSize) {
        const batch = enrichedProducts.slice(i, i + batchSize);
        await Promise.all(batch.map(async (p) => {
            const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
            const prompt = `
                PRODUTO: ${p.name}
                PREÇO: ${priceText}
                LOJA: ${p.store}
                LINK: ${p.link}
                Crie legenda Telegram. Curta. Emoji. OBRIGATÓRIO PREÇO: ${priceText}. Final: 👇 Link:
            `;
            try {
                const result = await agent?.generateLegacy([{ role: "user", content: prompt }]);
                p.generatedMessage = result?.text || "";
            } catch (error) {
                p.generatedMessage = ""; 
            }
        }));
    }

    return { success: true, enrichedProducts };
  },
});

// Envio
async function sendTelegramMessage(product: Product): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chat) return false;

  try {
    const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);
    let text = product.generatedMessage || "";

    if (!text || !text.includes("R$")) {
      text = `🔥 *OFERTA IMPERDÍVEL*\n\n📦 ${product.name}\n\n💰 *${priceText}*\n\n👇 Link Oficial:`;
    }

    if (!text.includes(product.link)) text += `\n${product.link}`;

    const endpoint = product.image ? "sendPhoto" : "sendMessage";
    const body: any = { chat_id: chat, parse_mode: "Markdown" };

    if (product.image) {
      body.photo = product.image;
      body.caption = text;
    } else {
      body.text = text;
    }

    let res = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });

    if (!res.ok) {
      body.parse_mode = undefined;
      res = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
    }

    return res.ok;
  } catch {
    return false;
  }
}

async function markPosted(id: string) {
  try {
    await pool.query(`INSERT INTO posted_products (lomadee_product_id, posted_telegram) VALUES ($1, TRUE) ON CONFLICT (lomadee_product_id) DO NOTHING`, [id]);
  } catch {}
}

const publishStep = createStep({
  id: "publish",
  description: "Publish",
  inputSchema: z.object({ success: z.boolean(), enrichedProducts: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
  execute: async ({ inputData }) => {
    console.log("🚀 [Passo 4] Publicando...");
    if (!inputData.success) return { success: true, count: 0 };
    let count = 0;
    
    for (const p of inputData.enrichedProducts) {
      if (await sendTelegramMessage(p)) {
        await markPosted(p.id);
        count++;
        console.log(`✅ [${count}] Enviado: ${p.name} - R$ ${p.price}`);
        // Delay para evitar flood (2.5s)
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    return { success: true, count };
  }
});

export const promoPublisherWorkflow = createWorkflow({
  id: "promo-workflow",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
})
  .then(fetchProductsStep)
  .then(filterNewProductsStep)
  .then(generateCopyStep)
  .then(publishStep)
  .commit();
