import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- GRUPOS DE BUSCA EM CASCATA (Prioridade -> Fallback) ---
const SEARCH_GROUPS = [
    ["iPhone 15", "iPhone 13", "iPhone"],
    ["Samsung Galaxy S24", "Samsung Galaxy A55", "Samsung Galaxy"],
    ["PlayStation 5", "Console PlayStation", "Controle PS5"],
    ["Notebook Gamer", "Notebook Dell", "Notebook"],
    ["Airfryer Mondial", "Airfryer", "Eletroportáteis"],
    ["Smart TV 50", "Smart TV Samsung", "Smart TV"],
    ["Alexa Echo Dot", "Alexa", "Caixa de Som Inteligente"],
    ["Geladeira Frost Free", "Geladeira Brastemp", "Geladeira"],
    ["Tênis Nike", "Tênis Corrida", "Tênis Masculino"],
    ["Whey Protein", "Creatina", "Suplementos"]
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
      CREATE INDEX IF NOT EXISTS idx_uniq ON posted_products(product_id_unique);
    `);
    client.release();
  } catch (err) { console.error("❌ Erro DB:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

// --- PASSO 1: BUSCA INTELIGENTE (CASCATA) ---
const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    let allProducts: Product[] = [];
    
    // Seleciona um grupo aleatório para trabalhar neste ciclo
    const group = SEARCH_GROUPS[Math.floor(Math.random() * SEARCH_GROUPS.length)];
    console.log(`🚀 [Job] Iniciando ciclo para grupo: "${group[0]}"`);

    // Tenta os termos do grupo em ordem (Específico -> Genérico)
    for (const keyword of group) {
        if (allProducts.length >= 3) break; // Se já achou produtos, para.

        console.log(`   🔎 Buscando termo: "${keyword}"...`);
        
        // Tenta na busca Geral e em uma loja específica
        const stores = [STORES_TO_TRY[0], STORES_TO_TRY[Math.floor(Math.random() * (STORES_TO_TRY.length - 1)) + 1]];
        
        for (const store of stores) {
            try {
                await new Promise(r => setTimeout(r, 1200)); // Delay
                
                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 15, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products?.length) {
                    // --- FILTRO DE SEGURANÇA FINAL ---
                    // Garante que o nome do produto tenha a ver com a busca atual
                    // (O 'lomadeeTool' já filtra muito, mas isso é a última barreira)
                    const keyTerms = keyword.toLowerCase().split(" ").filter(w => w.length > 2);
                    
                    const valid = res.products.filter((p: any) => {
                        const name = p.name.toLowerCase();
                        // Aceita se tiver pelo menos uma palavra chave importante E preço > 15
                        return keyTerms.some(t => name.includes(t)) && p.price > 15;
                    });

                    if (valid.length > 0) {
                        console.log(`      ✅ Sucesso: ${valid.length} itens encontrados.`);
                        allProducts.push(...valid);
                        if (!store.id) break; // Achou na geral, economiza tempo
                    }
                }
            } catch (e) {}
        }
        
        // Se achou produtos com esse termo, não precisa tentar o termo mais genérico
        if (allProducts.length > 0) break;
    }

    // Deduplicação
    const uniqueMap = new Map();
    allProducts.forEach(p => uniqueMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueMap.values());

    console.log(`📦 [Job] Produtos Válidos Coletados: ${uniqueProducts.length}`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

// --- PASSO 2: FILTRAGEM DE DUPLICATAS ---
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

            // Verifica se já postou nos últimos 3 dias
            const res = await client.query(
                `SELECT 1 FROM posted_products WHERE product_id_unique = $1 AND posted_at > NOW() - INTERVAL '3 days'`,
                [p.id]
            );

            if (res.rowCount === 0) finalSelection.push(p);
        }
    } finally { client.release(); }

    if (finalSelection.length > 0) console.log(`✨ [Job] ${finalSelection.length} ofertas prontas para envio.`);
    else console.log("⏸️ [Job] Produtos encontrados, mas já foram postados recentemente.");

    return { success: finalSelection.length > 0, newProducts: finalSelection };
  }
});

// --- PASSO 3: GERAÇÃO DE COPY ---
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
        const prompt = `Crie um post curto para Telegram (oferta urgente). Produto: ${p.name}. Loja: ${p.store}. Preço: ${price}. Link: ${p.link}. Use Emojis!`;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch { p.generatedMessage = ""; }
    }));
    return { success: true, enrichedProducts };
  }
});

// --- PASSO 4: PUBLICAÇÃO COM RETRY ---
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
            reply_markup: { inline_keyboard: [[{ text: "🛒 IR PARA A LOJA", url: p.link }]] }
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
