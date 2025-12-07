import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
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
  generatedMessage: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

// --- CORREÇÃO DE PREÇO ---
function safeParseFloat(value: any): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  
  // Converte para string
  let str = String(value);
  
  // Se tiver formato brasileiro "1.200,50", remove os pontos de milhar primeiro
  if (str.includes(",") && str.includes(".")) {
    str = str.replace(/\./g, ""); // Remove pontos de milhar
  }
  
  // Substitui vírgula decimal por ponto
  str = str.replace(",", ".");
  
  // Remove qualquer coisa que não seja número ou ponto
  str = str.replace(/[^0-9.]/g, "");
  
  return parseFloat(str) || 0;
}

// --- CORREÇÃO DE LOJA ---
function getStoreFromLink(link: string, fallback: string): string {
  if (!link) return fallback;
  const lower = link.toLowerCase();
  
  if (lower.includes("amazon")) return "Amazon";
  if (lower.includes("magalu") || lower.includes("magazineluiza")) return "Magalu";
  if (lower.includes("shopee")) return "Shopee";
  if (lower.includes("mercadolivre")) return "Mercado Livre";
  if (lower.includes("casasbahia")) return "Casas Bahia";
  if (lower.includes("americanas")) return "Americanas";
  if (lower.includes("girafa")) return "Girafa";
  if (lower.includes("fastshop")) return "Fast Shop";
  if (lower.includes("ponto")) return "Ponto Frio";
  if (lower.includes("extra")) return "Extra";
  if (lower.includes("kabum")) return "KaBuM!";
  
  return fallback;
}

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
      const params = new URLSearchParams({ page: "1", limit: "60", sort: "discount" });
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
        // Tenta pegar da API, se não, tenta adivinhar pelo link
        const storeName = item.store?.name || getStoreFromLink(rawLink, "Loja Parceira");
        
        return {
          id: String(item.id || item.productId || Math.random().toString(36)),
          name: item.name || item.productName || "Produto Oferta",
          price: safeParseFloat(item.price || item.salePrice), // Usa o parser corrigido
          originalPrice: safeParseFloat(item.originalPrice || item.priceFrom),
          discount: item.discount || 0,
          link: rawLink,
          image: item.image || item.thumbnail || "",
          store: storeName,
          category: item.category?.name || item.categoryName || "Geral",
          generatedMessage: "",
        };
      });

      // Filtra produtos com preço zero para não enviar erro
      const validProducts = products.filter(p => p.price > 0);

      return { success: true, products: validProducts };
    } catch (error) {
      return { success: false, products: [], error: String(error) };
    }
  },
});

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
      
      const selected: Product[] = [];
      const usedStores = new Set<string>();
      const MAX = 3;

      for (const p of available) {
        if (selected.length >= MAX) break;
        // Normaliza nome da loja para comparar
        const sKey = p.store.toLowerCase();
        
        // Se a loja não foi usada E não é genérica "loja parceira"
        if (!usedStores.has(sKey) || sKey === "loja parceira") {
          selected.push(p);
          if (sKey !== "loja parceira") usedStores.add(sKey);
        }
      }

      if (selected.length < MAX) {
        for (const p of available) {
          if (selected.length >= MAX) break;
          if (!selected.some(s => s.id === p.id)) selected.push(p);
        }
      }

      console.log(`🔎 [DIVERSIDADE] Lojas: ${selected.map(p => p.store).join(" | ")}`);
      return { success: true, newProducts: selected, alreadyPostedCount: result.rowCount || 0 };
    } catch {
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }
  },
});

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
    if (!inputData.success || inputData.newProducts.length === 0) {
      return { success: true, enrichedProducts: [] };
    }

    const agent = mastra?.getAgent("promoPublisherAgent");
    const enrichedProducts = [...inputData.newProducts];

    for (let i = 0; i < enrichedProducts.length; i++) {
      const p = enrichedProducts[i];
      const price = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
      
      const prompt = `
        PRODUTO: ${p.name}
        PREÇO: ${price}
        LOJA: ${p.store}
        LINK: ${p.link}
        
        Crie uma legenda para Telegram.
        REGRAS:
        1. Comece com um emoji de fogo ou alerta.
        2. Texto curto e persuasivo.
        3. OBRIGATÓRIO CITAR O PREÇO: ${price}
        4. Finalize com "👇 Toque no link abaixo:"
      `;

      try {
        const result = await agent?.generateLegacy([{ role: "user", content: prompt }]);
        p.generatedMessage = result?.text || "";
      } catch (error) {
        console.error(`Erro IA (falha segura):`, error);
        p.generatedMessage = ""; 
      }
    }

    return { success: true, enrichedProducts };
  },
});

async function sendTelegramMessage(product: Product): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chat) return false;

  try {
    const price = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);
    let text = product.generatedMessage || "";

    // Fallback se a IA falhar ou não puser o preço
    if (!text || !text.includes("R$")) {
      text = `🔥 *OFERTA IMPERDÍVEL*\n\n📦 ${product.name}\n\n💰 *${price}*\n\n👇 Link Oficial:`;
    }

    // Se a IA não colocou o link, adicionamos no final como precaução
    if (!text.includes(product.link)) {
        text += `\n${product.link}`;
    }

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
      body.parse_mode = undefined; // Tenta sem markdown se falhar
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
    if (!inputData.success) return { success: true, count: 0 };
    let count = 0;
    for (const p of inputData.enrichedProducts) {
      if (await sendTelegramMessage(p)) {
        await markPosted(p.id);
        count++;
        console.log(`✅ Postado: ${p.name} - R$ ${p.price}`);
        await new Promise(r => setTimeout(r, 2000));
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
