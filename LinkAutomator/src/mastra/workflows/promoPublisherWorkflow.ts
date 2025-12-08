import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- CONFIGURAÇÃO ---
// Lista expandida com ID de lojas populares na Lomadee
const STORES_TO_TRY = [
    { id: "5632", name: "Magalu" },
    { id: "5636", name: "Casas Bahia" },
    { id: "5766", name: "Amazon" },
    { id: "6116", name: "AliExpress" },
    { id: "5693", name: "Nike" },
    { id: "6373", name: "Girafa" },
    { id: "5778", name: "Carrefour" },
    { id: "6078", name: "Centauro" },
    { id: "5938", name: "KaBuM!" },
    { id: undefined, name: "Busca Geral" }
];

// LISTA REAL DE PRODUTOS (Sem marcas fictícias)
const KEYWORDS = [
  "Smartphone Samsung", "iPhone 15", "iPhone 14", "iPhone 13", "Xiaomi Redmi", "Motorola Moto G",
  "Notebook Gamer", "MacBook Air", "Monitor LG", "Teclado Mecânico", "Mouse Logitech", "Headset Gamer", 
  "Smart TV 50", "Smart TV 55", "Echo Dot Alexa", "Tablet Samsung", "iPad", "Kindle",
  "PlayStation 5", "Xbox Series S", "Nintendo Switch", "Controle PS5",
  "Cadeira Gamer", "Mesa Escritório",
  "Airfryer Mondial", "Airfryer Philco", "Geladeira Frost Free", "Micro-ondas", "Cafeteira Três Corações", "Ventilador", "Ar-condicionado Inverter", "Robô Aspirador",
  "Tênis Nike", "Tênis Adidas", "Mochila Notebook", "Smartwatch Samsung", "Apple Watch",
  "Parafusadeira Bosch", "Jogo de Panelas", "Pneu Aro 13", "Pneu Aro 15"
];

// Configuração do Banco de Dados
async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
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

// --- PASSO 1: BUSCA ROBUSTA ---
const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    // 1. Seleciona 3 palavras-chave aleatórias da lista
    const selectedKeywords: string[] = [];
    while (selectedKeywords.length < 3) {
        const k = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
        if (!selectedKeywords.includes(k)) selectedKeywords.push(k);
    }
    
    console.log(`🚀 [Multi-Search] Iniciando ciclo para: ${selectedKeywords.join(", ")}`);

    let allProducts: Product[] = [];

    // 2. Itera sobre cada palavra-chave
    for (const keyword of selectedKeywords) {
        // CORREÇÃO DO FILTRO: Quebra a busca em termos (ex: "Geladeira", "Frost", "Free")
        // Filtramos palavras pequenas para evitar falsos positivos com "de", "com", etc.
        const searchTerms = keyword.toLowerCase().split(" ").filter(w => w.length > 2);
        
        console.log(`🔎 Processando termo: "${keyword}" em ${STORES_TO_TRY.length} canais...`);

        // 3. Dispara buscas em PARALELO
        const storePromises = STORES_TO_TRY.map(async (store) => {
            try {
                await new Promise(r => setTimeout(r, Math.random() * 500)); // Delay antispa

                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 10, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products && res.products.length > 0) {
                    // --- NOVO FILTRO DE COERÊNCIA (MAIS INTELIGENTE) ---
                    // Aceita se o nome do produto contiver PELO MENOS UMA das palavras chave importantes.
                    // Ex: Busca "BioZen Geladeira". Produto "Geladeira Consul".
                    // "Geladeira" bate -> Aceita.
                    const validItems = res.products.filter((p: any) => {
                        const name = p.name.toLowerCase();
                        const matches = searchTerms.some(term => name.includes(term));
                        return matches && p.price > 20; // Preço mínimo
                    });
                    
                    if (validItems.length > 0) {
                        // console.log(`   ✅ [${store.name}] Encontrou ${validItems.length} itens compatíveis.`);
                    }
                    return validItems;
                }
            } catch (e) { }
            return [];
        });

        const results = await Promise.all(storePromises);
        results.forEach(items => allProducts.push(...items));
    }

    // 4. Limpeza Final
    const uniqueProducts = Array.from(new Map(allProducts.map(item => [item.id, item])).values());
    const shuffled = uniqueProducts.sort(() => 0.5 - Math.random());

    console.log(`✅ CICLO CONCLUÍDO: ${uniqueProducts.length} produtos únicos encontrados.`);
    return { success: shuffled.length > 0, products: shuffled };
  },
});

// --- PASSO 2: FILTRAGEM DB ---
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
        const postedSet = new Set(res.rows.map((r: any) => r.product_id_unique));
        
        const newProducts = candidates.filter(p => !postedSet.has(p.id));
        
        // Seleciona até 3 produtos para postar neste ciclo
        const finalSelection = newProducts.slice(0, 3);
        
        console.log(`🛡️ Filtragem: ${candidates.length} candidatos -> ${finalSelection.length} selecionados para envio.`);
        return { success: finalSelection.length > 0, newProducts: finalSelection };
    } catch (e) { 
        return { success: false, newProducts: [] }; 
    }
  }
});

// --- PASSO 3: GERAÇÃO DE TEXTO ---
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
        Aja como um canal de ofertas no Telegram.
        Produto: ${p.name}
        Loja: ${p.store}
        Preço: ${price}
        Link: ${p.link}
        
        Escreva uma legenda curta (máx 3 linhas). Use emojis (🔥, 🚨). Destaque o preço e parcelamento se souber.
        Não use hashtags.
        `;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch { p.generatedMessage = ""; }
    }));
    return { success: true, enrichedProducts };
  }
});

// --- PASSO 4: PUBLICAÇÃO ---
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
        let text = p.generatedMessage || `🔥 *OFERTA!*\n\n📦 ${p.name}\n💰 *${priceFormatted}*\n🏬 ${p.store}`;
        
        if (!text.includes("http")) text += `\n\n👇 *COMPRE AQUI:*\n${p.link}`;

        if (amazonTag) {
            const amazonLink = `https://www.amazon.com.br/s?k=${encodeURIComponent(p.name)}&tag=${amazonTag}`;
            text += `\n\n🔎 [Ver na Amazon](${amazonLink})`;
        }

        const body: any = { 
            chat_id: chat, 
            parse_mode: "Markdown", 
            text: text,
            reply_markup: { inline_keyboard: [[{ text: "🛒 IR PARA A LOJA", url: p.link }]] }
        };

        if (p.image) { body.photo = p.image; body.caption = text; delete body.text; }

        try {
            const endpoint = p.image ? "sendPhoto" : "sendMessage";
            await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p.id, p.name]);
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
