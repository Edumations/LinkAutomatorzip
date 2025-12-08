import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// LISTA DE LOJAS
const STORES_TO_TRY = [
    { id: "5632", name: "Magalu" },
    { id: "5636", name: "Casas Bahia" },
    { id: "5766", name: "Amazon" },
    { id: "6116", name: "AliExpress" },
    { id: "5693", name: "Nike" },
    { id: "6373", name: "Girafa" },
    { id: undefined, name: "Busca Geral" } 
];

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
    // Limpeza desativada para produção (ative se quiser testar do zero)
    // await client.query('DELETE FROM posted_products');
    await client.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        product_id_unique VARCHAR(255) UNIQUE NOT NULL,
        product_name TEXT,
        posted_at TIMESTAMP DEFAULT NOW()
      );
    `);
    client.release();
  } catch (err) { console.error("❌ Erro DB:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

const KEYWORDS = [
  "Smartphone", "iPhone", "Samsung Galaxy", "Notebook", "Smartwatch", 
  "Monitor Gamer", "Teclado Mecânico", "Mouse Gamer", "Headset", "Caixa de som JBL", 
  "TV 4K", "Alexa Echo", "Tablet", "Placa de vídeo", "Processador", 
  "PlayStation 5", "Xbox Series", "Nintendo Switch", "Cadeira Gamer", 
  "Airfryer", "Geladeira", "Micro-ondas", "Cafeteira Expresso", 
  "Ar-condicionado", "Tênis de Corrida", "Bicicleta"
];

const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    console.log("🚀 [Passo 1] Iniciando Busca Inteligente...");
    const keyword = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
    const targetStore = STORES_TO_TRY[Math.floor(Math.random() * STORES_TO_TRY.length)];
    console.log(`🔎 Buscando: "${keyword}" na ${targetStore.name}`);

    let allProducts: Product[] = [];

    try {
        // MUDANÇA 1: sort="relevance" para trazer o produto certo, não acessório
        const res: any = await lomadeeTool.execute({ 
            context: { keyword, limit: 50, sort: "relevance", storeId: targetStore.id }, 
            mastra 
        });
        
        if (res?.products && res.products.length > 0) {
            allProducts = res.products;
        } else {
            console.log(`⚠️ Falha na ${targetStore.name}. Tentando Geral...`);
            const resGeral: any = await lomadeeTool.execute({ 
                context: { keyword, limit: 50, sort: "relevance" }, 
                mastra 
            });
            if (resGeral?.products) allProducts = resGeral.products;
        }
    } catch (e) { console.error("Erro:", e); }

    // MUDANÇA 2: Filtro de preço mínimo (R$ 30) para evitar cabos e capas baratas
    // E garante que o preço seja maior que 0
    const filteredProducts = allProducts.filter(p => p.price > 30);

    // Embaralha para variar
    const shuffled = filteredProducts.sort(() => 0.5 - Math.random());

    const uniqueProducts = Array.from(new Map(shuffled.map(item => [item.id, item])).values());
    console.log(`✅ TOTAL VÁLIDO: ${uniqueProducts.length} produtos (Preço > 30).`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

const filterStep = createStep({
  id: "filter-products",
  inputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  execute: async ({ inputData }) => {
    if (!inputData.success || inputData.products.length === 0) return { success: false, newProducts: [] };
    const candidates = inputData.products;
    const ids = candidates.map(p => p.id);
    if (ids.length === 0) return { success: false, newProducts: [] };
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");

    try {
        const res = await pool.query(`SELECT product_id_unique FROM posted_products WHERE product_id_unique IN (${placeholders})`, ids);
        const posted = new Set(res.rows.map((r: any) => r.product_id_unique));
        const newProducts = candidates.filter(p => !posted.has(p.id));
        console.log(`✅ Inéditos: ${newProducts.length}.`);
        return { success: true, newProducts: newProducts.slice(0, 3) };
    } catch (e) { return { success: false, newProducts: [] }; }
  }
});

const copyStep = createStep({
  id: "generate-copy",
  inputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), enrichedProducts: z.array(ProductSchema) }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData.success) return { success: true, enrichedProducts: [] };
    const agent = mastra?.getAgent("promoPublisherAgent");
    const enrichedProducts = [...inputData.newProducts];

    await Promise.all(enrichedProducts.map(async (p) => {
        const price = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        const prompt = `Post Telegram curto. Produto: ${p.name}. Preço: ${price}. Loja: ${p.store}. Link: ${p.link}. Emojis!`;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch { p.generatedMessage = ""; }
    }));
    return { success: true, enrichedProducts };
  }
});

const publishStep = createStep({
  id: "publish",
  inputSchema: z.object({ success: z.boolean(), enrichedProducts: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
  execute: async ({ inputData }) => {
    if (!inputData.success) return { success: true, count: 0 };
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHANNEL_ID;
    const amazonTag = process.env.AMAZON_PARTNER_TAG; 
    let count = 0;

    for (const p of inputData.enrichedProducts) {
        if (!token || !chat) continue;
        
        // Formata o preço para o texto
        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        
        let text = p.generatedMessage || `🔥 ${p.name}\n💰 ${priceFormatted}`;
        // Se a IA falhou em por o preço, forçamos aqui
        if (!text.includes("R$")) text += `\n💰 ${priceFormatted}`;
        if (!text.includes("http")) text += `\n👇 Oferta Principal:\n${p.link}`;

        if (amazonTag) {
            const amazonLink = `https://www.amazon.com.br/s?k=${encodeURIComponent(p.name)}&tag=${amazonTag}`;
            text += `\n\n🔎 *Ver na Amazon:*\n${amazonLink}`;
        }

        const body: any = { chat_id: chat, parse_mode: "Markdown", text: text };
        if (p.image) { body.photo = p.image; body.caption = text; delete body.text; }

        try {
            await fetch(`https://api.telegram.org/bot${token}/${p.image ? "sendPhoto" : "sendMessage"}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p.id, p.name]);
            count++;
            console.log(`📢 Postado: ${p.name} - ${priceFormatted}`);
            await new Promise(r => setTimeout(r, 4000));
        } catch (e) { console.error("Erro Telegram:", e); }
    }
    return { success: true, count };
  }
});

export const promoPublisherWorkflow = createWorkflow({
  id: "promo-workflow",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
})
  .then(fetchStep).then(filterStep).then(copyStep).then(publishStep).commit();
