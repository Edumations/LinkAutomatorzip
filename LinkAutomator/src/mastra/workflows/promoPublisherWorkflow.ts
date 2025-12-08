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
    await client.query('DELETE FROM posted_products');
    console.log("💥 HISTÓRICO LIMPO COM SUCESSO! O bot vai repostar tudo. 💥")
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
  originKeyword: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

const KEYWORDS = [
  "Smart TV", "Celular", "Geladeira", "Notebook", "Air Fryer", 
  "Ar Condicionado", "Monitor", "Cadeira", "Lavadora", 
  "Fogão", "Microondas", "Iphone", "Samsung", "PlayStation",
  "Bluetooth", "Tablet", "Ventilador", "Sofá", "Guarda Roupa",
  "Tênis", "Whey", "Fralda", "Relógio", "Cafeteira", 
  "Aspirador", "Liquidificador", "Batedeira", "Teclado",
  "Mouse", "Fone", "Câmera", "Drone", "Impressora", "Caixa de Som"
];

// --- IDs DAS LOJAS ---
const STORES = {
  AMAZON: "5766",
  MAGALU: "5632",
  CASAS_BAHIA: "5636",
  ALIEXPRESS: "6116",
  NIKE: "5693",
  SHOPEE: "6265",
  NETSHOES: "5632" // (Usando Magalu/Netshoes ID genérico se não tiver específico, ou ajuste)
};

// --- ROTEADOR INTELIGENTE: Define onde buscar cada coisa ---
function getStoresForKeyword(keyword: string) {
  const k = keyword.toLowerCase();

  // Esportes e Vestuário
  if (["tênis", "tenis", "whey", "camisa", "suplemento"].some(w => k.includes(w))) {
    return [
      { id: STORES.NIKE, name: "Nike" },
      { id: STORES.NETSHOES, name: "Netshoes" },
      { id: STORES.AMAZON, name: "Amazon" }
    ];
  }

  // Eletrônicos Importados / Bugigangas
  if (["drone", "bluetooth", "fone", "acessório", "capa"].some(w => k.includes(w))) {
    return [
      { id: STORES.ALIEXPRESS, name: "AliExpress" },
      { id: STORES.SHOPEE, name: "Shopee" },
      { id: STORES.AMAZON, name: "Amazon" }
    ];
  }

  // Eletrodomésticos Grandes e Móveis
  if (["geladeira", "lavadora", "fogão", "sofá", "guarda roupa", "ar condicionado"].some(w => k.includes(w))) {
    return [
      { id: STORES.MAGALU, name: "Magalu" },
      { id: STORES.CASAS_BAHIA, name: "Casas Bahia" }
    ];
  }

  // Tech / Geral (Padrão)
  return [
    { id: STORES.AMAZON, name: "Amazon" },
    { id: STORES.MAGALU, name: "Magalu" },
    { id: STORES.CASAS_BAHIA, name: "Casas Bahia" }
  ];
}

function safeParseFloat(value: any): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  let str = String(value);
  if (str.includes(",") && str.includes(".")) str = str.replace(/\./g, "");
  str = str.replace(",", ".");
  str = str.replace(/[^0-9.]/g, "");
  return parseFloat(str) || 0;
}

function extractDeepData(item: any) {
  let price = safeParseFloat(item.price || item.salePrice || item.priceMin || item.priceMax);
  let originalPrice = safeParseFloat(item.originalPrice || item.priceFrom || item.priceMax);
  let store = item.store?.name || item.storeName || item.advertiser?.name;
  let image = item.image || item.thumbnail;

  if ((price === 0 || !store) && item.options && item.options.length > 0) {
    const opt = item.options.find((o: any) => o.available) || item.options[0];
    if (opt.pricing && opt.pricing.length > 0) {
        const p = opt.pricing[0];
        if (price === 0) price = safeParseFloat(p.price || p.salePrice || p.listPrice);
    }
    if (price === 0) price = safeParseFloat(opt.price);
    if (!store) store = opt.seller?.name || opt.seller || "Loja Parceira";
    if (opt.images && opt.images.length > 0) {
        const imgObj = opt.images[0];
        image = imgObj.url || imgObj.large || imgObj.medium || image;
    }
  }
  return { price, originalPrice, store, image };
}

function getStoreFromLink(link: string, fallback: string): string {
  if (!link) return fallback;
  const lower = link.toLowerCase();
  const stores: Record<string, string> = {
    "amazon": "Amazon", "magalu": "Magalu", "shopee": "Shopee", 
    "mercadolivre": "Mercado Livre", "casasbahia": "Casas Bahia",
    "nike": "Nike", "aliexpress": "AliExpress"
  };
  for (const key in stores) {
    if (lower.includes(key)) return stores[key];
  }
  return fallback;
}

// Passo 1: Buscar Produtos (COM ROTEAMENTO INTELIGENTE)
const fetchProductsStep = createStep({
  id: "fetch-lomadee-products",
  description: "Fetches products with smart routing",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),
  execute: async ({ mastra }) => {
    const apiKey = process.env.LOMADEE_API_KEY;
    const sourceId = process.env.LOMADEE_SOURCE_ID;
    
    if (!apiKey) return { success: false, products: [], error: "Missing Key" };

    const fetchAPI = async (params: URLSearchParams, label: string) => {
      try {
        if (sourceId) params.append("sourceId", sourceId);
        
        // Timeout de 8s para não travar o bot
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          { 
            method: "GET", 
            headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
            signal: controller.signal
          }
        );
        clearTimeout(timeoutId);
        
        if (!res.ok) {
            console.error(`❌ [${label}] Erro HTTP: ${res.status}`);
            return [];
        }
        const data = await res.json();
        return data.data || [];
      } catch (e) { 
        return []; 
      }
    };

    const shuffled = [...KEYWORDS].sort(() => 0.5 - Math.random());
    const targets = shuffled.slice(0, 8); // Reduzi para 8 para ser mais rápido
    console.log(`🚀 [Passo 1] Buscando: ${targets.join(", ")}`);

    let allProducts: Product[] = [];

    for (const keyword of targets) {
      // 1. Descobre quais lojas fazem sentido para essa keyword
      const targetStores = getStoresForKeyword(keyword);
      // 2. Escolhe uma delas aleatoriamente
      const chosenStore = targetStores[Math.floor(Math.random() * targetStores.length)];
      
      const sortMethods = ["discount", "price", "relevance"]; 
      const randomSort = sortMethods[Math.floor(Math.random() * sortMethods.length)];

      console.log(`🔎 Buscando "${keyword}" na ${chosenStore.name} (${randomSort})...`);
      
      let rawItems = await fetchAPI(
          new URLSearchParams({ 
              keyword, 
              sort: randomSort, 
              limit: "3", 
              storeId: chosenStore.id 
          }), 
          `${keyword} @ ${chosenStore.name}`
      );

      // Fallback: Se não achou na loja específica, tenta busca global
      if (rawItems.length === 0) {
         console.log(`⚠️ Nada na ${chosenStore.name}. Tentando "${keyword}" geral...`);
         rawItems = await fetchAPI(
            new URLSearchParams({ keyword, sort: "relevance", limit: "3" }), 
            `${keyword} (Global)`
        );
      }
      
      const parsedItems = rawItems.map((item: any) => {
        const extracted = extractDeepData(item);
        const rawLink = item.link || item.url || "";
        return {
          id: String(item.id || item.productId || Math.random().toString(36)),
          name: item.name || item.productName || "Oferta",
          price: extracted.price,
          originalPrice: extracted.originalPrice,
          discount: item.discount || 0,
          link: rawLink,
          image: extracted.image || "",
          store: extracted.store || getStoreFromLink(rawLink, "Loja Parceira"),
          category: keyword,
          originKeyword: keyword,
          generatedMessage: "",
        };
      });

      allProducts.push(...parsedItems.filter(p => p.price > 10)); // Filtra itens muito baratos (erros)
      await new Promise(r => setTimeout(r, 800)); // Pequena pausa
    }

    // Remover duplicatas brutas da API
    const uniqueProducts = Array.from(new Map(allProducts.map(item => [item.id, item])).values());

    console.log(`✅ [Passo 1] Total Encontrado: ${uniqueProducts.length} produtos.`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

// Passo 2: Filtrar (Com lógica anti-spam)
const filterNewProductsStep = createStep({
  id: "filter-new-products",
  description: "Filters duplicates from DB",
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
      
      // Verifica no banco
      const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ");
      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        productIds
      );

      const postedIds = new Set(result.rows.map((row: any) => row.lomadee_product_id));
      const available = inputData.products.filter((p) => !postedIds.has(p.id));
      
      console.log(`🧐 [Filtro] De ${inputData.products.length} encontrados, ${postedIds.size} já foram postados.`);

      // Seleciona até 10 para não floodar
      const selected = available.slice(0, 10);

      console.log(`✅ [Passo 2] ${selected.length} produtos PRONTOS para postar.`);
      return { success: true, newProducts: selected, alreadyPostedCount: result.rowCount || 0 };
    } catch (e) {
      console.error("Erro no filtro:", e);
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

    // Processa em paralelo para ser mais rápido
    await Promise.all(enrichedProducts.map(async (p) => {
        const priceText = p.price > 0 
            ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price)
            : "Confira!";
            
        const prompt = `
            Escreva uma oferta curta para Telegram.
            PRODUTO: ${p.name}
            PREÇO: ${priceText}
            LOJA: ${p.store}
            
            Use emojis. Seja direto.
            Formato:
            🔥 [Nome do Produto]
            
            💰 [Preço] na [Loja]
            
            👇 Link abaixo:
        `;
        try {
            const result = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = result?.text || "";
        } catch (error) {
            p.generatedMessage = ""; 
        }
    }));

    return { success: true, enrichedProducts };
  },
});

// Envio
async function sendTelegramMessage(product: Product): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chat) return false;

  try {
    const priceText = product.price > 0 
        ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price)
        : "Oferta!";
        
    let text = product.generatedMessage || "";
    // Fallback se a IA falhar ou o texto for vazio
    if (!text || text.length < 10) {
      text = `🔥 *${product.name}*\n\n💰 *${priceText}*\n🏠 Loja: ${product.store}\n\n👇 Link Oficial:`;
    }
    // Garante que o link esteja no final se a IA esqueceu
    if (!text.includes("http")) text += `\n${product.link}`;

    const endpoint = product.image ? "sendPhoto" : "sendMessage
