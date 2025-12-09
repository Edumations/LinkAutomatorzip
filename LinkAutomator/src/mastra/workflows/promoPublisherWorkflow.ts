import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- DICIONÁRIO DE BUSCA EM CASCATA ---
// Estrutura: { termo_principal: [tentativa1, tentativa2, tentativa3] }
const SEARCH_GROUPS = [
    ["iPhone 15", "iPhone 14", "iPhone", "Smartphone Apple"],
    ["Samsung Galaxy S24", "Samsung Galaxy S23", "Samsung Galaxy", "Smartphone Samsung"],
    ["PlayStation 5", "Console PlayStation", "Controle PS5", "Games"],
    ["Notebook Gamer Dell", "Notebook Dell", "Notebook i5", "Notebook"],
    ["Airfryer Mondial", "Airfryer", "Fritadeira", "Eletroportáteis"],
    ["Smart TV 50 4K", "Smart TV Samsung", "Smart TV", "TV"],
    ["Alexa Echo Pop", "Echo Dot", "Alexa", "Smart Speaker"],
    ["Tênis Nike Running", "Tênis Nike", "Tênis Corrida", "Tênis"]
];

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
      CREATE INDEX IF NOT EXISTS idx_posted_time ON posted_products(posted_at);
    `);
    client.release();
  } catch (err) { console.error("❌ Erro DB Setup:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

// --- PASSO 1: BUSCA CASCATA ---
const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    let allProducts: Product[] = [];
    
    // Escolhe um grupo de busca aleatório (ex: Grupo do iPhone)
    const searchGroup = SEARCH_GROUPS[Math.floor(Math.random() * SEARCH_GROUPS.length)];
    
    console.log(`🚀 [Job] Iniciando Cascata para grupo: "${searchGroup[0]}"`);

    // Tenta cada termo da cascata até achar produtos
    for (const keyword of searchGroup) {
        if (allProducts.length >= 3) break; // Já achou o suficiente

        console.log(`   🔎 Tentando termo: "${keyword}"...`);
        
        // Tenta Geral + 1 Loja Específica
        const stores = [STORES_TO_TRY[0], STORES_TO_TRY[Math.floor(Math.random() * (STORES_TO_TRY.length - 1)) + 1]];
        
        for (const store of stores) {
            try {
                await new Promise(r => setTimeout(r, 1200)); // Delay
                
                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 15, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products?.length) {
                    // Validação: Nome deve conter pelo menos uma palavra chave importante
                    // Ex: Se buscou "iPhone 15", aceita "iPhone" no nome.
                    const keyTerms = keyword.toLowerCase().split(" ").filter(w => w.length > 2);
                    
                    const valid = res.products.filter((p: any) => {
                        const normName = p.name.toLowerCase();
                        return keyTerms.some(t => normName.includes(t)) && p.price > 20;
                    });

                    if (valid.length > 0) {
                        console.log(`      ✅ Sucesso! ${valid.length} itens encontrados para "${keyword}".`);
                        allProducts.push(...valid);
                        if (!store.id) break; // Se achou na geral, pula o resto pra economizar tempo
                    }
                }
            } catch (e) {}
        }
        
        if (allProducts.length > 0) break; // Se achou com esse termo, para a cascata.
    }

    // Deduplicação
    const uniqueMap = new Map();
    allProducts.forEach(p => uniqueMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueMap.values());

    console.log(`📦 [Job] Total Final: ${uniqueProducts.length} produtos.`);
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
            if (finalSelection.length >= 4) break; 

            const res = await client.query(
                `SELECT 1 FROM posted_products WHERE product_id_unique = $1 AND posted_at > NOW() - INTERVAL '3 days'`,
                [p.id]
            );

            if (res.rowCount === 0) finalSelection.push(p);
        }
    } finally { client.release(); }

    if (finalSelection.length > 0) console.log(`✨ [Job] ${finalSelection.length} ofertas prontas.`);
    else console.log("⏸️ [Job] Duplicatas filtradas.");

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
        const prompt = `Post Telegram. Produto: ${p.name}. Preço: ${price}. Link: ${p.link}. Emojis!`;
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

    const fetchWithRetry = async (url: string, opts: any, retries = 3) => {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url, opts);
                if (!res.ok) throw new Error(res.statusText);
                return res;
            } catch (err) {
                if (i === retries - 1) throw err;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    };

    for (const p of inputData.enrichedProducts) {
        if (!token || !chat) break;
        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        let text = p.generatedMessage || `🔥 ${p.name}\n💰 ${priceFormatted}`;
        const body: any = { 
            chat_id: chat, parse_mode: "Markdown", 
            text: `${text}\n\n👇 *LINK:* ${p.link}`,
            reply_markup: { inline_keyboard: [[{ text: "🛒 VER NA LOJA", url: p.link }]] }
        };
        if (p.image) { body.photo = p.image; body.caption = body.text; delete body.text; }

        try {
            await fetchWithRetry(
                `https://api.telegram.org/bot${token}/${p.image ? "sendPhoto" : "sendMessage"}`, 
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            );
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2)`, [p.id, p.name]);
            count++;
            console.log(`📢 Postado: ${p.name}`);
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) { console.error(`❌ Erro Telegram ${p.name}:`, e); }
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
