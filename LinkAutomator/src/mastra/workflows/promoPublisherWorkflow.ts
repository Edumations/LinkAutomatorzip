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
  originKeyword: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

const KEYWORDS = [
  "Smart TV", "Smartphone", "Geladeira", "Notebook", "Air Fryer", 
  "Ar Condicionado", "Monitor Gamer", "Cadeira Gamer", "Lavadora", 
  "Fogão", "Microondas", "Iphone", "Samsung", "PlayStation",
  "Fone Bluetooth", "Tablet", "Ventilador", "Sofá", "Guarda Roupa",
  "Tênis", "Whey Protein", "Fralda", "Smartwatch",
  "Cafeteira", "Aspirador", "Liquidificador", "Batedeira", "Teclado",
  "Mouse", "Headset", "Câmera", "Drone", "Impressora", "Caixa de Som"
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

// Passo 1: Buscar Produtos (COM FALLBACK)
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

    const fetchAPI = async (params: URLSearchParams) => {
      try {
        const res = await fetch(
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          { method: "GET", headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
        );
        if (!res.ok) return [];
        const data = await res.json();
        return data.data || [];
      } catch { return []; }
    };

    // 1. Tenta buscar por categorias específicas
    const shuffledKeywords = [...KEYWORDS].sort(() => 0.5 - Math.random());
    const selectedKeywords = shuffledKeywords.slice(0, 15); // Reduzi para 15 para aliviar API
    console.log(`🚀 [Passo 1] Tentando 15 categorias: ${selectedKeywords.join(", ")}`);

    const allProducts: Product[] = [];
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < selectedKeywords.length; i += BATCH_SIZE) {
        const batch = selectedKeywords.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (k) => {
          const rawItems = await fetchAPI(new URLSearchParams({ keyword: k, sort: "discount", limit: "10" }));
          return rawItems.map((item: any) => ({
            id: String(item.id || item.productId || Math.random().toString(36)),
            name: item.name || item.productName || "Oferta",
            price: getBestPrice(item),
            originalPrice: safeParseFloat(item.originalPrice || item.priceFrom || item.priceMax),
            discount: item.discount || 0,
            link: item.link || item.url || "",
            image: item.image || item.thumbnail || "",
            store: item.store?.name || getStoreFromLink(item.link || "", "Loja Parceira"),
            category: item.category?.name || item.categoryName || k,
            originKeyword: k,
            generatedMessage: "",
          }));
        }));
        results.forEach(list => allProducts.push(...list));
        // Pequeno delay entre batches para evitar bloqueio
        await new Promise(r => setTimeout(r, 1000));
    }

    let validProducts = allProducts.filter(p => p.price > 0.01);
    console.log(`📊 [Resultados] Específico encontrou: ${validProducts.length}`);

    // 2. FALLBACK: Se encontrou pouco, faz uma busca GERAL (Top Ofertas)
    if (validProducts.length < 10) {
      console.log("⚠️ Poucos produtos encontrados. Ativando busca GERAL de emergência...");
      const randomPage = Math.floor(Math.random() * 5) + 1;
      const rawGeneral = await fetchAPI(new URLSearchParams({ page: String(randomPage), limit: "100", sort: "discount" }));
      
      const generalProducts = rawGeneral.map((item: any) => ({
          id: String(item.id || item.productId || Math.random().toString(36)),
          name: item.name || item.productName || "Oferta",
          price: getBestPrice(item),
          originalPrice: safeParseFloat(item.originalPrice || item.priceFrom || item.priceMax),
          discount: item.discount || 0,
          link: item.link || item.url || "",
          image: item.image || item.thumbnail || "",
          store: item.store?.name || getStoreFromLink(item.link || "", "Loja Parceira"),
          category: item.category?.name || item.categoryName || "Geral",
          originKeyword: "Geral",
          generatedMessage: "",
      }));

      // Junta os produtos específicos com os gerais
      validProducts = [...validProducts, ...generalProducts.filter((p: Product) => p.price > 0
