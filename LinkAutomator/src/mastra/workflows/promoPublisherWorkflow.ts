import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// LISTA DE BUSCA (Prioridade para categorias com alto estoque)
const KEYWORDS = [
  "iPhone", "Samsung Galaxy", "Xiaomi", "Motorola", 
  "Notebook", "MacBook", "Monitor", "Teclado Gamer", 
  "TV 50", "Alexa", "Kindle", "PlayStation 5", "Nintendo Switch",
  "Airfryer", "Geladeira", "Ventilador", "Tênis Nike", "Whey Protein"
];

// LOJAS (Mantemos a lista, mas a ferramenta agora aceita buscar na "Geral" se storeId for undefined)
const STORES_TO_TRY = [
    { id: undefined, name: "Geral" }, 
    { id: "5766", name: "Amazon" },
    { id: "5632", name: "Magalu" },
    { id: "6116", name: "AliExpress" },
    { id: "5938", name: "KaBuM!" }
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
  } catch (err) { console.error("❌ Erro DB:", err); }
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
    // Escolhe 2 palavras para o ciclo
    const selectedKeywords: string[] = [];
    while (selectedKeywords.length < 2) {
        const k = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
        if (!selectedKeywords.includes(k)) selectedKeywords.push(k);
    }
    
    console.log(`🚀 [Job] Iniciando busca para: ${selectedKeywords.join(" | ")}`);
    let allProducts: Product[] = [];

    for (const keyword of selectedKeywords) {
        // Tenta buscar na Geral e em +1 loja aleatória para variar
        const stores = [STORES_TO_TRY[0], STORES_TO_TRY[Math.floor(Math.random() * (STORES_TO_TRY.length - 1)) + 1]];
        
        for (const store of stores) {
            try {
                // Pequeno delay
                await new Promise(r => setTimeout(r, 1500));
                
                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 10, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products?.length) {
                    // Filtra itens com preço muito baixo (erro de cadastro ou acessório irrelevante)
                    const valid = res.products.filter((p: any) => p.price > 15);
                    if (valid.length > 0) {
                        allProducts.push(...valid);
                        // Se achou na geral, já está bom para essa keyword
                        if (!store.id) break;
                    }
                }
            } catch (e) {}
        }
    }

    // Remove duplicatas
    const uniqueMap = new Map();
    allProducts.forEach(p => uniqueMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueMap.values());

    console.log(`✅ [Job] Candidatos encontrados: ${uniqueProducts.length}`);
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
            if (finalSelection.length >= 4) break; // Posta até 4 por vez

            // Permite repostar após 3 dias
            const res = await client.query(
                `SELECT 1 FROM posted_products WHERE product_id_unique = $1 AND posted_at > NOW() - INTERVAL '3 days'`,
                [p.id]
            );

            if (res.rowCount === 0) finalSelection.push(p);
        }
    } finally { client.release(); }

    console.log(`✨ [Job] ${finalSelection.length} ofertas novas selecionadas.`);
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
        const prompt = `Crie post Telegram curto. Produto: ${p.name}. Loja: ${p.store}. Preço: ${price}. Link: ${p.link}. Use emojis!`;
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
            chat_id: chat, parse_mode: "Markdown", 
            text: `${text}\n\n👇 *COMPRE AQUI:*\n${p.link}`,
            reply_markup: { inline_keyboard: [[{ text: "🛒 VER NA LOJA", url: p.link }]] }
        };
        if (p.image) { body.photo = p.image; body.caption = body.text; delete body.text; }

        try {
            await fetch(`https://api.telegram.org/bot${token}/${p.image ? "sendPhoto" : "sendMessage"}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2)`, [p.id, p.name]);
            count++;
            console.log(`📢 Postado: ${p.name}`);
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
