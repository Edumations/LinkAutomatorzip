import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// LISTA ESTENDIDA DE LOJAS (IDs variados para maximizar chance de match)
const STORES_TO_TRY = [
    { id: undefined, name: "Geral (Buscapé)" }, // A mais importante, deixamos primeiro
    { id: "5632", name: "Magalu" },
    { id: "5766", name: "Amazon" },
    { id: "5636", name: "Casas Bahia" },
    { id: "6116", name: "AliExpress" },
    { id: "5938", name: "KaBuM!" },
    { id: "6373", name: "Girafa" },
    { id: "5778", name: "Carrefour" }
];

const KEYWORDS = [
  "iPhone 15", "iPhone 13", "Samsung Galaxy", "Xiaomi Redmi", 
  "Notebook Dell", "Notebook Acer", "MacBook", "Monitor LG", 
  "Teclado Gamer", "Mouse Logitech", "Headset", 
  "Smart TV 50", "Smart TV 43", "Alexa", "Kindle",
  "PlayStation 5", "Xbox Series", "Nintendo Switch",
  "Cadeira Gamer", "Airfryer", "Geladeira", "Lavadora",
  "Tênis Nike", "Tênis Adidas", "Whey Protein"
];

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        product_id_unique VARCHAR(255) NOT NULL,
        product_name TEXT,
        posted_at TIMESTAMP DEFAULT NOW()
      );
    `);
    client.release();
  } catch (err) { console.error("❌ Erro DB Setup:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    // Busca até 3 palavras aleatórias
    const selectedKeywords: string[] = [];
    while (selectedKeywords.length < 3) {
        const k = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
        if (!selectedKeywords.includes(k)) selectedKeywords.push(k);
    }
    
    console.log(`🚀 [Job] Buscando: ${selectedKeywords.join(" | ")}`);
    let allProducts: Product[] = [];

    for (const keyword of selectedKeywords) {
        const terms = keyword.toLowerCase().split(" ").filter(w => w.length > 2);
        
        // Executa em série para não tomar Rate Limit
        for (const store of STORES_TO_TRY) {
            try {
                // Delay aleatório entre 1s e 2s (API da Lomadee é sensível)
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
                
                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 10, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products?.length) {
                    const valid = res.products.filter((p: any) => {
                        const name = p.name.toLowerCase();
                        // Filtro Relaxado: Aceita se tiver pelo menos 1 palavra principal e preço > 10
                        return terms.some(t => name.includes(t)) && p.price > 10;
                    });

                    if (valid.length > 0) {
                        console.log(`   ✅ [${store.name}] Encontrou ${valid.length} itens para "${keyword}".`);
                        allProducts.push(...valid);
                        // Se achou na Busca Geral, pula as lojas específicas para economizar tempo
                        if (!store.id) break; 
                    }
                }
            } catch (e) {}
        }
    }

    // Deduplicação
    const uniqueMap = new Map();
    allProducts.forEach(p => uniqueMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueMap.values());

    console.log(`✅ [Job] Total de Candidatos: ${uniqueProducts.length}`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

const filterStep = createStep({
  id: "filter-products",
  inputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  execute: async ({ inputData }) => {
    if (!inputData.success || !inputData.products.length) return { success: false, newProducts: [] };
    
    const candidates = inputData.products.sort(() => 0.5 - Math.random());
    const finalSelection: Product[] = [];
    const client = await pool.connect();

    try {
        for (const p of candidates) {
            if (finalSelection.length >= 5) break; // Aumentei para 5 posts

            // Repostagem permitida após 2 dias (48h)
            const res = await client.query(
                `SELECT 1 FROM posted_products WHERE product_id_unique = $1 AND posted_at > NOW() - INTERVAL '2 days'`,
                [p.id]
            );

            if (res.rowCount === 0) finalSelection.push(p);
        }
    } finally { client.release(); }

    console.log(`✨ [Job] ${finalSelection.length} ofertas prontas para envio.`);
    return { success: finalSelection.length > 0, newProducts: finalSelection };
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
        // Prompt simplificado para garantir resposta rápida
        const prompt = `Post Telegram. Produto: ${p.name}. Loja: ${p.store}. Preço: ${price}. Link: ${p.link}. Emojis!`;
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
    let count = 0;

    for (const p of inputData.enrichedProducts) {
        if (!token || !chat) break;
        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        let text = p.generatedMessage || `🔥 ${p.name}\n💰 ${priceFormatted}`;
        const body: any = { 
            chat_id: chat, parse_mode: "Markdown", text: `${text}\n\n👇 *COMPRE AQUI:*\n${p.link}`,
            reply_markup: { inline_keyboard: [[{ text: "🛒 VER NA LOJA", url: p.link }]] }
        };
        if (p.image) { body.photo = p.image; body.caption = body.text; delete body.text; }

        try {
            await fetch(`https://api.telegram.org/bot${token}/${p.image ? "sendPhoto" : "sendMessage"}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2)`, [p.id, p.name]);
            count++;
            console.log(`📢 Enviado: ${p.name}`);
            await new Promise(r => setTimeout(r, 6000));
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
