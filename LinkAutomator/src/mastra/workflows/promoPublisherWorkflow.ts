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

function safeParseFloat(value: any): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  let str = String(value);
  if (str.includes(",") && str.includes(".")) str = str.replace(/\./g, "");
  str = str.replace(",", ".");
  str = str.replace(/[^0-9.]/g, "");
  return parseFloat(str) || 0;
}

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
  if (lower.includes("friopecas") || lower.includes("frio peças")) return "FrioPeças";
  return fallback;
}

// Passo 1: Buscar Produtos (PÁGINA ALEATÓRIA + 100 ITENS)
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
      // MUDANÇA: Página aleatória entre 1 e 5 para evitar pegar sempre as mesmas ofertas
      const randomPage = Math.floor(Math.random() * 5) + 1;
      console.log(`🚀 [Passo 1] Buscando na Lomadee (Página ${randomPage})...`);

      const params = new URLSearchParams({ 
        page: String(randomPage), 
        limit: "100", // Pega bastante para poder filtrar
        sort: "rating" // MUDANÇA: 'rating' ou sem sort costuma ter dados mais limpos que 'discount'
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
        
        // Tenta vários campos de preço
        const price = safeParseFloat(item.price || item.salePrice || item.priceMin || item.priceMax);

        return {
          id: String(item.id || item.productId || Math.random().toString(36)),
          name: item.name || item.productName || "Produto Oferta",
          price: price,
          originalPrice: safeParseFloat(item.originalPrice || item.priceFrom || item.priceMax),
          discount: item.discount || 0,
          link: rawLink,
          image: item.image || item.thumbnail || "",
          store: storeName,
          category: item.category?.name || item.categoryName || "Geral",
          generatedMessage: "",
        };
      });

      // MUDANÇA: Filtra RIGOROSAMENTE produtos sem preço.
      const validProducts = products.filter(p => p.price > 0.01);
      
      console.log(`✅ [Passo 1] ${validProducts.length} produtos válidos (com preço > 0).`);
      return { success: true, products: validProducts };
    } catch (error) {
      return { success: false, products: [], error: String(error) };
    }
  },
});

// Passo 2: Filtrar com Diversidade (LIMITE POR LOJA)
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
    console.log("🚀 [Passo 2] Filtrando diversidade...");
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
      // Filtra já postados E SEM PREÇO (segurança dupla)
      const available = inputData.products.filter((p) => !postedIds.has(p.id) && p.price > 0);
      
      const selected: Product[] = [];
      const storeCounts: Record<string, number> = {}; // Contador por loja
      const MAX_TOTAL = 20;
      const MAX_PER_STORE = 2; // MUDANÇA: Máximo 2 produtos da MESMA loja por vez

      for (const p of available) {
        if (selected.length >= MAX_TOTAL) break;
        
        const sKey = (p.store || "outros").toLowerCase();
        const currentCount = storeCounts[sKey] || 0;

        // Só adiciona se a loja ainda não atingiu o limite
        if (currentCount < MAX_PER_STORE) {
          selected.push(p);
          storeCounts[sKey] = currentCount + 1;
        }
      }

      // Se não encheu os 20 apenas com lojas variadas, libera o limite para preencher
      if (selected.length < 5) { // Se tiver muito pouco
         console.log("⚠️ Pouca variedade, liberando repetições...");
         for (const p of available) {
            if (selected.length >= MAX_TOTAL) break;
            if (!selected.some(s => s.id === p.id)) selected.push(p);
         }
      }

      console.log(`✅ [Passo 2] Selecionados: ${selected.length}`);
      console.log(`🏪 Lojas: ${[...new Set(selected.map(p => p.store))].join(", ")}`);
      
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
    console.log("🚀 [Passo 3] Criando textos...");
    if (!inputData.success || inputData.newProducts.length === 0) {
      return { success: true, enrichedProducts: [] };
    }

    const agent = mastra?.getAgent("promoPublisherAgent");
    const enrichedProducts = [...inputData.newProducts];

    // Processa um por um para não estourar rate limit da IA se tiver
    for (let i = 0; i < enrichedProducts.length; i++) {
      const p = enrichedProducts[i];
      const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
      
      const prompt = `
        PRODUTO: ${p.name}
        PREÇO: ${priceText}
        LOJA: ${p.store}
        LINK: ${p.link}
        
        Crie uma legenda para Telegram.
        1. Headline curta com Emoji.
        2. Fale do produto em 1 frase.
        3. OBRIGATÓRIO: "${priceText}"
        4. Finalize: 👇 Link Oficial:
      `;

      try {
        const result = await agent?.generateLegacy([{ role: "user", content: prompt }]);
        p.generatedMessage = result?.text || "";
      } catch (error) {
        // Silencioso para não poluir log, usa fallback
        p.generatedMessage = ""; 
      }
    }

    return { success: true, enrichedProducts };
  },
});

// Envio e Marcação
async function sendTelegramMessage(product: Product): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chat) return false;

  try {
    const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);
    let text = product.generatedMessage || "";

    // Fallback se a IA falhar OU se a IA esqueceu o preço
    if (!text || !text.includes("R$")) {
      text = `🔥 *OFERTA IMPERDÍVEL*\n\n📦 ${product.name}\n\n💰 *${priceText}*\n\n👇 Link Oficial:`;
    }

    // Garante que o link está na mensagem
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
        console.log(`✅ [${count}] Enviado: ${p.name} (${p.store}) - R$ ${p.price}`);
        await new Promise(r => setTimeout(r, 3000)); // 3s delay
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
