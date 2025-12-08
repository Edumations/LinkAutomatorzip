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
    // Cria tabela se não existir
    await client.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        lomadee_product_id VARCHAR(255) UNIQUE NOT NULL,
        product_name TEXT,
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
  link: z.string(),
  image: z.string().optional(),
  store: z.string().optional(),
  category: z.string().optional(),
  generatedMessage: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

// Lista de buscas variada
const KEYWORDS = [
  "Smart TV", "Smartphone", "Geladeira", "Notebook", "Air Fryer", 
  "Ar Condicionado", "Monitor Gamer", "Cadeira Gamer", "Lavadora", 
  "Fogão", "Microondas", "Iphone", "Samsung Galaxy", "PlayStation 5",
  "Caixa de Som JBL", "Tablet Samsung", "Ventilador", "Sofá", 
  "Tênis Nike", "Tênis Adidas", "Whey Protein", "Relógio Inteligente", 
  "Cafeteira Expresso", "Aspirador Robô", "Batedeira Planetária"
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

function extractDeepData(item: any) {
  let price = safeParseFloat(item.price || item.salePrice || item.priceMin || item.priceMax);
  let originalPrice = safeParseFloat(item.originalPrice || item.priceFrom || item.priceMax);
  let store = item.store?.name || item.storeName || item.advertiser?.name;
  let image = item.image || item.thumbnail;

  if ((price === 0 || !store) && item.options && item.options.length > 0) {
    const opt = item.options.find((o: any) => o.available) || item.options[0];
    if (price === 0) price = safeParseFloat(opt.price || opt.salePrice);
    if (!store) store = opt.seller?.name || opt.seller || "Loja Parceira";
    if (opt.images && opt.images.length > 0) {
        const imgObj = opt.images[0];
        image = imgObj.url || imgObj.large || imgObj.medium || image;
    }
  }
  return { price, originalPrice, store, image };
}

// Importe a ferramenta se necessário, ou use via mastra.getTool (recomendado no step)

// ... (todo o código anterior de imports e setupDatabase continua igual) ...

// Passo 1: Busca Híbrida (Lomadee + Mercado Livre)
const fetchProductsStep = createStep({
  id: "fetch-products-hybrid",
  description: "Busca na Lomadee e Mercado Livre",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
  }),
  execute: async ({ mastra }) => {
    console.log("🚀 Iniciando Busca Híbrida...");
    
    // Categorias para buscar
    const KEYWORDS = ["Iphone", "Smart TV", "Notebook", "Air Fryer", "PlayStation 5"];
    const keyword = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
    console.log(`🔎 Palavra-chave da vez: ${keyword}`);

    let allProducts: Product[] = [];

    // --- 1. TENTA LOMADEE ---
    try {
        const lomadeeTool = mastra?.getTool("lomadee-fetch-products"); // Nome que definimos na tool
        if (lomadeeTool) {
            const res: any = await lomadeeTool.execute({ 
                context: { keyword, limit: 3, sort: "discount" },
                mastra 
            });
            if (res?.products) {
                allProducts.push(...res.products);
                console.log(`📦 Lomadee trouxe: ${res.products.length}`);
            }
        }
    } catch (e) { console.error("Erro Lomadee:", e); }

    // --- 2. TENTA MERCADO LIVRE ---
    try {
        const mlTool = mastra?.getTool("mercadolivre-search"); // Nome que definimos na tool nova
        if (mlTool) {
            const res: any = await mlTool.execute({ 
                context: { keyword, limit: 3 },
                mastra 
            });
            
            if (res?.products) {
                // Adaptar o formato do ML para o formato do nosso banco
                const mlProducts = res.products.map((p: any) => ({
                    id: `ML-${p.id}`, // Prefixo para não confundir IDs
                    name: p.name,
                    price: p.price,
                    originalPrice: p.price * 1.1, // Fake original price (ML não entrega fácil na busca)
                    link: p.link, // ⚠️ AQUI ENTRA O SEU LINK DE AFILIADO DEPOIS
                    image: p.image,
                    store: "Mercado Livre",
                    category: keyword,
                    generatedMessage: ""
                }));
                allProducts.push(...mlProducts);
                console.log(`📦 Mercado Livre trouxe: ${mlProducts.length}`);
            }
        }
    } catch (e) { console.error("Erro ML:", e); }

    // Mistura tudo
    const uniqueProducts = Array.from(new Map(allProducts.map(item => [item.id, item])).values());
    
    console.log(`✅ TOTAL FINAL: ${uniqueProducts.length} produtos.`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

// ... (O resto do workflow: filter, generateCopy e publish continua igual)

// Passo 2: Filtro de Banco de Dados
const filterNewProductsStep = createStep({
  id: "filter-new-products",
  inputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    newProducts: z.array(ProductSchema),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.success || inputData.products.length === 0) {
        return { success: false, newProducts: [] };
    }
    try {
      const productIds = inputData.products.map((p) => p.id);
      const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ");
      
      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        productIds
      );

      const postedIds = new Set(result.rows.map((row: any) => row.lomadee_product_id));
      // Filtra os que NÃO estão no set de postedIds
      const newProducts = inputData.products.filter((p) => !postedIds.has(p.id));
      
      // Seleciona no máximo 3 para postar por vez (evita spam)
      const selected = newProducts.slice(0, 3);
      
      console.log(`✨ Produtos Inéditos: ${selected.length}`);
      return { success: true, newProducts: selected };
    } catch (e) {
      console.error("Erro filtro DB:", e);
      return { success: false, newProducts: [] };
    }
  },
});

// Passo 3: IA
const generateCopyStep = createStep({
  id: "generate-copy",
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

    await Promise.all(enrichedProducts.map(async (p) => {
        const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        const prompt = `
            Escreva um post curto para Telegram.
            Produto: ${p.name}
            Preço: ${priceText}
            Loja: ${p.store}
            Link: ${p.link}
            Use emojis. Fale que está barato. Finalize com o link.
        `;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch (e) { p.generatedMessage = ""; }
    }));

    return { success: true, enrichedProducts };
  },
});

// Passo 4: Publicar
const publishStep = createStep({
  id: "publish",
  inputSchema: z.object({ success: z.boolean(), enrichedProducts: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
  execute: async ({ inputData }) => {
    if (!inputData.success || inputData.enrichedProducts.length === 0) return { success: true, count: 0 };

    let count = 0;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHANNEL_ID;

    for (const p of inputData.enrichedProducts) {
      if (!token || !chat) continue;
      
      const priceText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
      let text = p.generatedMessage || `🔥 ${p.name}\n💰 ${priceText}\n👇 ${p.link}`;
      
      // Fallback para garantir link
      if (!text.includes("http")) text += `\n\n👇 Compre aqui: ${p.link}`;

      const body: any = { chat_id: chat, parse_mode: "Markdown", text: text };
      // Se tiver imagem, muda endpoint
      const endpoint = p.image ? "sendPhoto" : "sendMessage";
      if (p.image) { body.photo = p.image; body.caption = text; delete body.text; }

      try {
        await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body: JSON.stringify(body)
        });
        
        // Salva no banco
        await pool.query(
            `INSERT INTO posted_products (lomadee_product_id, product_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, 
            [p.id, p.name]
        );
        count++;
        console.log(`✅ Postado: ${p.name}`);
        await new Promise(r => setTimeout(r, 4000)); // Delay Telegram
      } catch (e) { console.error("Erro envio Telegram:", e); }
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
