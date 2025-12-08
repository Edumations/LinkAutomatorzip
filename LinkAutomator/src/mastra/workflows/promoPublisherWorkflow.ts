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
    { id: "5778", name: "Carrefour" },
    { id: undefined, name: "Busca Geral" }
];

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
    // Limpeza desativada.
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
  "Monitor", "Teclado", "Mouse", "Headset", "JBL", 
  "TV", "Alexa", "Tablet", "Placa de vídeo", "Processador", 
  "PlayStation", "Xbox", "Nintendo", "Cadeira Gamer", 
  "Airfryer", "Geladeira", "Micro-ondas", "Cafeteira", "Ventilador", 
  "Ar-condicionado", "Tênis", "Mochila", "Ferramentas", "Pneu"
];

const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    console.log("🚀 [Passo 1] Iniciando Busca MULTLOJA com FILTRO DE COERÊNCIA...");
    
    const keyword = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
    // Pega a primeira palavra da busca para validar (ex: "PlayStation" de "PlayStation 5")
    const mainKeyword = keyword.split(" ")[0].toLowerCase();

    const selectedStores = STORES_TO_TRY.sort(() => 0.5 - Math.random()).slice(0, 3);
    console.log(`🔎 Buscando: "${keyword}" (Validação: deve conter "${mainKeyword}")`);

    let allProducts: Product[] = [];

    await Promise.all(selectedStores.map(async (store) => {
        try {
            const res: any = await lomadeeTool.execute({ 
                context: { keyword, limit: 15, sort: "relevance", storeId: store.id }, 
                mastra 
            });
            
            if (res?.products && res.products.length > 0) {
                // --- FILTRO DE COERÊNCIA ---
                // Verifica se o nome do produto contém a palavra-chave principal
                const coherentProducts = res.products.filter((p: any) => 
                    p.name.toLowerCase().includes(mainKeyword)
                );

                if (coherentProducts.length > 0) {
                    console.log(`✅ ${store.name}: ${coherentProducts.length} itens válidos (filtrou ${res.products.length - coherentProducts.length} lixos).`);
                    allProducts.push(...coherentProducts);
                } else {
                    console.log(`🗑️ ${store.name}: Retornou ${res.products.length} itens, mas nenhum era "${keyword}". Descartados.`);
                }
            }
        } catch (e) { console.error(`Erro ${store.name}:`, e); }
    }));

    if (allProducts.length === 0) {
        console.log("⚠️ Nenhuma loja trouxe o produto exato. Tentando Busca Geral...");
        try {
            const resGeral: any = await lomadeeTool.execute({ 
                context: { keyword, limit: 20, sort: "relevance" }, mastra 
            });
            // Aplica o mesmo filtro na busca geral
            if (resGeral?.products) {
                const validGeral = resGeral.products.filter((p: any) => p.name.toLowerCase().includes(mainKeyword));
                if (validGeral.length > 0) {
                    console.log(`📦 Busca Geral salvou o dia: ${validGeral.length} itens.`);
                    allProducts = validGeral;
                }
            }
        } catch (e) {}
    }

    // Filtro de preço mínimo
    const validProducts = allProducts.filter(p => p.price > 10);
    
    // Remove duplicatas
    const uniqueProducts = Array.from(new Map(validProducts.map(item => [item.id, item])).values());
    const shuffled = uniqueProducts.sort(() => 0.5 - Math.random());

    console.log(`✅ TOTAL FINAL VÁLIDO: ${shuffled.length} produtos.`);
    return { success: shuffled.length > 0, products: shuffled };
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
        console.log(`✅ Produtos Inéditos: ${newProducts.length}.`);
        return { success: true, newProducts: newProducts.slice(0, 5) };
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
        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        let text = p.generatedMessage || `🔥 ${p.name}\n💰 ${priceFormatted}`;
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
            console.log(`📢 Postado: ${p.name}`);
            await new Promise(r => setTimeout(r, 5000));
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
