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
  originKeyword: z.string().optional(), // Para rastrear a categoria de origem
});

type Product = z.infer<typeof ProductSchema>;

// Lista Expandida de Categorias (Mais de 30 opções para garantir variedade)
const KEYWORDS = [
  "Smart TV", "Smartphone", "Geladeira", "Notebook", "Air Fryer", 
  "Ar Condicionado", "Monitor Gamer", "Cadeira Gamer", "Lavadora", 
  "Fogão", "Microondas", "Iphone 15", "Samsung Galaxy", "PlayStation 5",
  "Fone Bluetooth", "Tablet", "Ventilador", "Sofá", "Guarda Roupa",
  "Tênis Nike", "Tênis Adidas", "Whey Protein", "Fralda", "Smartwatch",
  "Cafeteira", "Aspirador Robô", "Liquidificador", "Batedeira", "Teclado Gamer",
  "Mouse Gamer", "Headset", "Câmera", "Drone", "Impressora", "Caixa de Som JBL"
];

function safeParseFloat(value: any): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  let str = String(value);
  if (str.includes(",") && str.includes(".")) str = str.replace(/\./g, "");
  str = str.replace(",", ".");
  str = str.replace(/[^0-9.]/g, "");
  return parseFloat(str) || 0;
}

function getBestPrice(item: any): number {
  const possibilities = [item.price, item.salePrice, item.priceMin, item.priceMax];
  const validPrices = possibilities.map(safeParseFloat).filter(p => p > 0);
  return validPrices.length > 0 ? Math.min(...validPrices) : 0;
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
    "nike": "Nike", "adidas": "Adidas", "netshoes": "Netshoes", "centauro": "Centauro"
  };

  for (const key in stores) {
    if (lower.includes(key)) return stores[key];
  }
  return fallback;
}

// Passo 1: Buscar Produtos (20 CATEGORIAS x 1 PRODUTO)
const fetchProductsStep = createStep({
  id: "fetch-lomadee-products",
  description: "Fetches products from 20 different categories",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),
  execute: async ({ mastra }) => {
    const apiKey = process.env.LOMADEE_API_KEY;
    if (!apiKey) return { success: false, products: [], error: "Missing Key" };

    // Sorteia 20 categorias diferentes
    const shuffledKeywords = [...KEYWORDS].sort(() => 0.5 - Math.random());
    const selectedKeywords = shuffledKeywords.slice(0, 20);

    console.log(`🚀 [Passo 1] Categorias selecionadas: ${selectedKeywords.join(", ")}`);

    // Função de busca individual
    const fetchCategory = async (keyword: string) => {
      try {
        // Busca 5 produtos de cada categoria para garantir que pelo menos 1 seja válido e novo
        const params = new URLSearchParams({ 
          keyword: keyword,
          sort: "discount",
          limit: "5" 
        });
        
        const res = await fetch(
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          { method: "GET", headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
        );

        if (!res.ok) return [];
        const data = await res.json();
        
        return (data.data || []).map((item: any) => {
          const rawLink = item.link || item.url || "";
          return {
            id: String(item.id || item.productId || Math.random().toString(36)),
            name: item.name || item.productName || "Produto Oferta",
            price: getBestPrice(item),
            originalPrice: safeParseFloat(item.originalPrice || item.priceFrom || item.priceMax),
            discount: item.discount || 0,
            link: rawLink,
            image: item.image || item.thumbnail || "",
            store: item.store?.name || getStoreFromLink(rawLink, "Loja Parceira"),
            category: item.category?.name || item.categoryName || keyword,
            originKeyword: keyword, // Marca a categoria de origem para filtragem
            generatedMessage: "",
          };
        });
      } catch (e) {
        return [];
      }
    };

    // Executa em lotes de 5 requisições paralelas para não sobrecarregar a API
    const allProducts: Product[] = [];
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < selectedKeywords.length; i += BATCH_SIZE) {
        const batch = selectedKeywords.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(k => fetchCategory(k)));
        results.forEach(list => allProducts.push(...list));
    }

    // Filtra produtos sem preço válido logo de cara
    const validProducts = allProducts.filter(p => p.price > 0.01);

    console.log(`✅ [Passo 1] Total de candidatos encontrados: ${validProducts.length}`);
    return { success: true, products: validProducts };
  },
});

// Passo 2: Filtrar (SELECIONAR 1 POR CATEGORIA)
const filterNewProductsStep = createStep({
  id: "filter-new-products",
  description: "Filters products selecting 1 per category",
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
    console.log("🚀 [Passo 2] Selecionando 1 produto de cada categoria...");
    if (!inputData.success || inputData.products.length === 0) {
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }

    try {
      const productIds = inputData.products.map((p) => p.id);
      if (productIds.length === 0) return { success: false, newProducts: [], alreadyPostedCount: 0 };

      const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ");
      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        productIds
      );

      const postedIds = new Set(result.rows.map((row: any) => row.lomadee_product_id));
      const available = inputData.products.filter((p) => !postedIds.has(p.id));
      
      const selected: Product[] = [];
      const usedKeywords = new Set<string>();

      // Algoritmo de Seleção: Pega o primeiro produto disponível de cada categoria (keyword)
      for (const p of available) {
        const keyword = p.originKeyword || "geral";
        
        // Se ainda não escolhemos um produto desta categoria, escolhe agora
        if (!usedKeywords.has(keyword)) {
          selected.push(p);
          usedKeywords.add(keyword);
        }
        
        // Se já temos 20 produtos (meta atingida), para
        if (selected.length >= 20) break;
      }

      console.log(`✅ [Passo 2] ${selected.length} produtos variados prontos para envio.`);
      console.log(`📊 Mix: ${[...usedKeywords].join(", ")}`);
      
      return { success: true, newProducts: selected, alreadyPostedCount: result.rowCount || 0 };
    } catch (e) {
      console.error(e);
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
    console.log(`🚀 [Passo 3] Gerando textos...`);
    if (!inputData.success || inputData.newProducts.length === 0) {
      return { success: true, enrichedProducts: [] };
    }

    const agent = mastra?.getAgent("promoPublisherAgent");
    const enrichedProducts = [...inputData.newProducts];
    const batchSize = 5;
    
    for (let i = 0; i < enrichedProducts.length; i += batchSize) {
        const batch = enrichedProducts.slice(i, i + batchSize);
        await Promise.all(batch.map(async (p) => {
            const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
            const prompt = `
                PRODUTO: ${p.name}
                PREÇO: ${priceText}
                LOJA: ${p.store}
                
                Legenda Telegram Curta e Vendedora. 
                1. Headline com emoji. 
                2. Benefício. 
                3. OBRIGATÓRIO PREÇO: ${priceText}
                4. Finalize com: 👇 Link:
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

// Envio e Marcação
async function sendTelegramMessage(product: Product): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chat) return false;

  try {
    const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);
    let text = product.generatedMessage || "";

    if (!text || !text.includes("R$")) {
      text = `🔥 *${product.name}*\n\n💰 *${priceText}*\n\n👇 Link Oficial:`;
    }

    if (!text.includes(product.link)) text += `\n${product.link}`;

    // FORÇA O ENVIO DE FOTO SE DISPONÍVEL
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
      // Se falhar (ex: imagem inválida ou markdown quebrado), tenta fallback de texto puro
      body.parse_mode = undefined;
      // Se era foto, tenta mudar para mensagem de texto no fallback
      if (endpoint === "sendPhoto") {
          const fallbackBody = { chat_id: chat, text: text };
          res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
             method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fallbackBody)
          });
      } else {
          res = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
          });
      }
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
        console.log(`✅ [${count}] Enviado: ${p.category} -> ${p.name}`);
        await new Promise(r => setTimeout(r, 3000));
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
