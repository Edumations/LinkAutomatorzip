import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- LISTAS ESTRATÉGICAS ---
const KEYWORDS = [
  "iPhone 15", "iPhone 13", "Samsung Galaxy S24", "Samsung Galaxy M55", "Xiaomi Redmi 13", "Motorola Edge", 
  "Notebook Dell Inspiron", "Notebook Acer Nitro", "MacBook Air M1", "Monitor Gamer 144hz", 
  "Teclado Redragon", "Mouse Logitech G", "Headset HyperX", "PlayStation 5 Slim", "Xbox Series S", "Nintendo Switch Oled",
  "Smart TV 50 4K", "Smart TV 43", "Alexa Echo Pop", "Kindle Paperwhite",
  "Cadeira Gamer", "Airfryer Mondial", "Airfryer Philips", "Geladeira Frost Free", "Ventilador de Mesa", "Máquina de Lavar",
  "Tênis Nike Air", "Tênis Adidas", "Whey Protein Max", "Creatina"
];

const STORES_TO_TRY = [
    { id: undefined, name: "Geral" }, 
    { id: "5766", name: "Amazon" },
    { id: "5632", name: "Magalu" },
    { id: "6116", name: "AliExpress" },
    { id: "5938", name: "KaBuM!" },
    { id: "5636", name: "Casas Bahia" }
];

// Setup Banco de Dados
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
      CREATE INDEX IF NOT EXISTS idx_prod_posted_at ON posted_products(posted_at);
      CREATE INDEX IF NOT EXISTS idx_prod_unique_id ON posted_products(product_id_unique);
    `);
    client.release();
  } catch (err) { console.error("❌ Erro DB Setup:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

// --- PASSO 1: BUSCA DE ALTO VOLUME (AUTO-RETRY) ---
const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    let attempts = 0;
    let allProducts: Product[] = [];
    
    // Tenta buscar até conseguir produtos ou estourar 2 tentativas (Anti-Zero)
    while (allProducts.length < 5 && attempts < 2) {
        attempts++;
        const selectedKeywords: string[] = [];
        // Pega 3 palavras aleatórias
        while (selectedKeywords.length < 3) {
            const k = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
            if (!selectedKeywords.includes(k)) selectedKeywords.push(k);
        }

        console.log(`🚀 [Job] Busca (Tentativa ${attempts}): ${selectedKeywords.join(" | ")}`);

        for (const keyword of selectedKeywords) {
            // Escolhe 2 lojas por palavra para não demorar demais
            const stores = [STORES_TO_TRY[0], STORES_TO_TRY[Math.floor(Math.random() * (STORES_TO_TRY.length - 1)) + 1]];
            
            for (const store of stores) {
                try {
                    await new Promise(r => setTimeout(r, 1000)); // Delay de cortesia
                    
                    const res: any = await lomadeeTool.execute({ 
                        // AUMENTO DE VOLUME: Limit 25
                        context: { keyword, limit: 25, sort: "relevance", storeId: store.id }, 
                        mastra 
                    });
                    
                    if (res?.products?.length) {
                        const valid = res.products.filter((p: any) => p.price > 20); // Filtra erros de preço
                        allProducts.push(...valid);
                    }
                } catch (e) {}
            }
        }
    }

    // Deduplicação por ID
    const uniqueMap = new Map();
    allProducts.forEach(p => uniqueMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueMap.values());

    console.log(`✅ [Job] Total Candidatos Brutos: ${uniqueProducts.length}`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

// --- PASSO 2: FILTRAGEM INTELIGENTE ---
const filterStep = createStep({
  id: "filter-products",
  inputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  execute: async ({ inputData }) => {
    if (!inputData.success || !inputData.products.length) return { success: false, newProducts: [] };
    
    // Embaralha para variar o conteúdo
    const candidates = inputData.products.sort(() => 0.5 - Math.random());
    const finalSelection: Product[] = [];
    const client = await pool.connect();

    try {
        for (const p of candidates) {
            if (finalSelection.length >= 5) break; // Posta até 5 ofertas por ciclo

            // Regra: Não repetir o MESMO produto nos últimos 3 dias
            const res = await client.query(
                `SELECT 1 FROM posted_products WHERE product_id_unique = $1 AND posted_at > NOW() - INTERVAL '3 days'`,
                [p.id]
            );

            if (res.rowCount === 0) finalSelection.push(p);
        }
    } finally { client.release(); }

    if (finalSelection.length === 0) {
        console.log("⚠️ [Job] Todos os itens encontrados já foram postados recentemente.");
    } else {
        console.log(`✨ [Job] ${finalSelection.length} ofertas inéditas aprovadas.`);
    }
    
    return { success: finalSelection.length > 0, newProducts: finalSelection };
  }
});

// --- PASSO 3: COPYWRITING ---
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
        // Prompt direto e vendedor
        const prompt = `Post Telegram Oferta. Produto: ${p.name}. Loja: ${p.store}. Preço: ${price}. Link: ${p.link}. Urgência! Emojis!`;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch { p.generatedMessage = ""; }
    }));
    return { success: true, enrichedProducts };
  }
});

// --- PASSO 4: PUBLICAÇÃO BLINDADA (Retry System) ---
const publishStep = createStep({
  id: "publish",
  inputSchema: z.object({ success: z.boolean(), enrichedProducts: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), count: z.number() }),
  execute: async ({ inputData }) => {
    if (!inputData.success) return { success: true, count: 0 };
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHANNEL_ID;
    let count = 0;

    // Função de Retry para rede instável
    const fetchWithRetry = async (url: string, opts: any, retries = 3) => {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url, opts);
                if (!res.ok) {
                    const txt = await res.text();
                    // Se for erro 429 (Too Many Requests), espera mais
                    if (res.status === 429) await new Promise(r => setTimeout(r, 10000));
                    throw new Error(`Status ${res.status}: ${txt}`);
                }
                return res;
            } catch (err) {
                if (i === retries - 1) throw err;
                console.log(`⚠️ [Telegram] Falha na tentativa ${i + 1}. Retentando...`);
                await new Promise(r => setTimeout(r, 2000 * (i + 1))); // Backoff exponencial
            }
        }
    };

    for (const p of inputData.enrichedProducts) {
        if (!token || !chat) { console.error("❌ Sem credenciais Telegram"); break; }

        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        let text = p.generatedMessage || `🔥 ${p.name}\n💰 ${priceFormatted}`;
        const body: any = { 
            chat_id: chat, parse_mode: "Markdown", 
            text: `${text}\n\n👇 *COMPRE AGORA:*\n${p.link}`,
            reply_markup: { inline_keyboard: [[{ text: "🛒 IR PARA A LOJA", url: p.link }]] }
        };
        if (p.image) { body.photo = p.image; body.caption = body.text; delete body.text; }

        try {
            const endpoint = p.image ? "sendPhoto" : "sendMessage";
            await fetchWithRetry(
                `https://api.telegram.org/bot${token}/${endpoint}`, 
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            );
            
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2)`, [p.id, p.name]);
            count++;
            console.log(`📢 Postado: ${p.name}`);
            await new Promise(r => setTimeout(r, 5000)); // Delay entre posts
        } catch (e) { 
            console.error(`❌ Erro Telegram Final para ${p.name}:`, e); 
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
  .then(fetchStep).then(filterStep).then(copyStep).then(publishStep).commit();
