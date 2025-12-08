import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// LISTA OTIMIZADA DE LOJAS
const STORES_TO_TRY = [
    { id: "5632", name: "Magalu" },
    { id: "5766", name: "Amazon" },
    { id: "5636", name: "Casas Bahia" },
    { id: "6116", name: "AliExpress" },
    { id: "5938", name: "KaBuM!" },
    { id: "6373", name: "Girafa" },
    { id: "5778", name: "Carrefour" },
    { id: "6078", name: "Centauro" },
    { id: undefined, name: "Geral" }
];

// PRODUTOS REAIS DE ALTA CONVERSÃO
const KEYWORDS = [
  "iPhone 15", "iPhone 13", "Samsung Galaxy S24", "Samsung Galaxy S23", "Xiaomi Redmi Note",
  "Notebook Dell", "Notebook Lenovo", "MacBook Air", "Monitor Gamer", 
  "Teclado Logitech", "Mouse Gamer", "Headset HyperX", 
  "TV Samsung 50", "TV LG 55", "Alexa Echo Pop", "Kindle",
  "PlayStation 5", "Xbox Series S", "Nintendo Switch",
  "Cadeira Gamer", "Airfryer Mondial", "Geladeira Brastemp", "Máquina de Lavar",
  "Tênis Nike Revolution", "Tênis Adidas Run", "Whey Protein", "Creatina"
];

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        product_id_unique VARCHAR(255) NOT NULL, -- Removida a constraint UNIQUE global para permitir repostagem futura controlada
        product_name TEXT,
        posted_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_product_id ON posted_products(product_id_unique);
    `);
    client.release();
  } catch (err) { console.error("❌ Erro DB:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

// --- PASSO 1: BUSCA MASSIVA ---
const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    const selectedKeywords: string[] = [];
    // Busca 3 categorias diferentes por vez
    while (selectedKeywords.length < 3) {
        const k = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
        if (!selectedKeywords.includes(k)) selectedKeywords.push(k);
    }
    
    console.log(`🚀 [Job] Buscando: ${selectedKeywords.join(" | ")}`);
    let allProducts: Product[] = [];

    for (const keyword of selectedKeywords) {
        // Filtro Flexível: Aceita se tiver pelo menos uma palavra chave principal (ex: "Galaxy")
        const terms = keyword.toLowerCase().split(" ").filter(w => w.length > 3);
        
        const promises = STORES_TO_TRY.map(async (store) => {
            try {
                // Pequeno delay para não travar a API
                await new Promise(r => setTimeout(r, Math.random() * 800));
                
                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 12, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products?.length) {
                    // Filtra lixo (nome não tem nada a ver ou preço errado)
                    return res.products.filter((p: any) => {
                        const name = p.name.toLowerCase();
                        return terms.some(t => name.includes(t)) && p.price > 50;
                    });
                }
            } catch (e) {}
            return [];
        });

        const results = await Promise.all(promises);
        results.forEach(items => allProducts.push(...items));
    }

    // Deduplicação final por ID (que agora contém a loja)
    const uniqueMap = new Map();
    allProducts.forEach(p => uniqueMap.set(p.id, p));
    const uniqueProducts = Array.from(uniqueMap.values());

    console.log(`✅ [Job] Encontrados ${uniqueProducts.length} produtos candidatos.`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

// --- PASSO 2: FILTRO INTELIGENTE (Permite Repost) ---
const filterStep = createStep({
  id: "filter-products",
  inputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  execute: async ({ inputData }) => {
    if (!inputData.success || !inputData.products.length) return { success: false, newProducts: [] };
    
    const candidates = inputData.products.sort(() => 0.5 - Math.random()); // Embaralha
    const finalSelection: Product[] = [];
    const client = await pool.connect();

    try {
        for (const p of candidates) {
            if (finalSelection.length >= 3) break; // Limite por ciclo

            // Verifica se foi postado nos últimos 3 DIAS
            const res = await client.query(
                `SELECT 1 FROM posted_products WHERE product_id_unique = $1 AND posted_at > NOW() - INTERVAL '3 days'`,
                [p.id]
            );

            if (res.rowCount === 0) {
                finalSelection.push(p);
            }
        }
    } catch (e) {
        console.error("Erro DB Filter:", e);
    } finally {
        client.release();
    }

    if (finalSelection.length === 0) {
        console.log("⏸️ [Job] Todos os itens encontrados já foram postados recentemente.");
    } else {
        console.log(`✨ [Job] ${finalSelection.length} ofertas inéditas selecionadas para envio.`);
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
        const prompt = `
        Crie um post de oferta URGENTE para Telegram.
        Produto: ${p.name}
        Loja: ${p.store}
        Preço: ${price}
        
        Texto curto, impactante, use emojis (🚨, 🔥, 📉). Destaque a economia. Sem hashtags.
        `;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch { p.generatedMessage = ""; }
    }));
    return { success: true, enrichedProducts };
  }
});

// --- PASSO 4: DISPARO ---
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
        if (!token || !chat) break;

        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        let text = p.generatedMessage || `🔥 *OFERTA IMPERDÍVEL!*\n\n📦 ${p.name}\n📉 *${priceFormatted}*\n🏬 Loja: ${p.store}`;
        
        if (!text.includes("http")) text += `\n\n👇 *GARANTA O SEU:*`;
        
        // Link principal (Lomadee)
        const btnLink = p.link;

        // Montagem do corpo
        const body: any = { 
            chat_id: chat, 
            parse_mode: "Markdown", 
            text: `${text}\n${btnLink}`, // Link no corpo para garantir clique
            // Botão inline bonitinho
            reply_markup: {
                inline_keyboard: [[{ text: "🛒 VER OFERTA AGORA", url: btnLink }]]
            }
        };

        if (amazonTag && p.store.toLowerCase().includes("amazon")) {
             // Se for Amazon, tenta usar tag, mas Lomadee já deve ter redirecionado. 
             // Mantemos simples para evitar conflito de links.
        }

        if (p.image) { 
            body.photo = p.image; 
            body.caption = body.text; 
            delete body.text; 
        }

        try {
            const endpoint = p.image ? "sendPhoto" : "sendMessage";
            await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            
            // Registra no banco para não repetir por 3 dias
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2)`, [p.id, p.name]);
            
            count++;
            console.log(`📢 Enviado: ${p.name} (${p.store})`);
            await new Promise(r => setTimeout(r, 8000)); // Delay entre posts
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
