import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- CONFIGURAÇÃO ---
// Adicionei mais lojas populares para aumentar o leque de busca
const STORES_TO_TRY = [
    { id: "5632", name: "Magalu" },
    { id: "5636", name: "Casas Bahia" },
    { id: "5766", name: "Amazon" },
    { id: "6116", name: "AliExpress" },
    { id: "5693", name: "Nike" },
    { id: "6373", name: "Girafa" },
    { id: "5778", name: "Carrefour" },
    { id: "6078", name: "Centauro" }, // Nova
    { id: "5938", name: "KaBuM!" },   // Nova
    { id: undefined, name: "Busca Geral" }
];

const KEYWORDS = [
  "Smartphone", "iPhone", "Samsung Galaxy", "Xiaomi", "Motorola",
  "Notebook Gamer", "MacBook", "Monitor", "Teclado Mecânico", "Mouse Gamer", "Headset", 
  "Smart TV", "Alexa", "Tablet", "iPad", "Kindle",
  "PlayStation 5", "Xbox Series", "Nintendo Switch", "Controle PS5",
  "Cadeira Gamer", "Mesa Gamer",
  "Airfryer", "Geladeira", "Micro-ondas", "Cafeteira Expresso", "Ventilador", "Ar-condicionado", "Robô Aspirador",
  "Tênis Nike", "Tênis Adidas", "Mochila", "Relógio Inteligente",
  "Furadeira", "Parafusadeira", "Jogo de Ferramentas", "Pneu"
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
    // Opcional: Limpar registros muito antigos (ex: > 30 dias) para não inchar o banco
    // await client.query("DELETE FROM posted_products WHERE posted_at < NOW() - INTERVAL '30 days'");
    client.release();
  } catch (err) { console.error("❌ Erro DB:", err); }
}
setupDatabase();

const ProductSchema = z.object({
  id: z.string(), name: z.string(), price: z.number(), link: z.string(), image: z.string().optional(), store: z.string().optional(), generatedMessage: z.string().optional(),
});
type Product = z.infer<typeof ProductSchema>;

// --- PASSO 1: BUSCA ROBUSTA (Múltiplas Keywords + Todas as Lojas) ---
const fetchStep = createStep({
  id: "fetch-lomadee",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    // 1. Seleciona 3 palavras-chave DISTINTAS para garantir variedade no feed
    const selectedKeywords: string[] = [];
    while (selectedKeywords.length < 3) {
        const k = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
        if (!selectedKeywords.includes(k)) selectedKeywords.push(k);
    }
    
    console.log(`🚀 [Multi-Search] Iniciando ciclo para: ${selectedKeywords.join(", ")}`);

    let allProducts: Product[] = [];

    // 2. Itera sobre cada palavra-chave
    for (const keyword of selectedKeywords) {
        const mainKeyword = keyword.split(" ")[0].toLowerCase(); // Validação simples
        console.log(`🔎 Processando termo: "${keyword}" em ${STORES_TO_TRY.length} canais...`);

        // 3. Dispara buscas em PARALELO para todas as lojas (Mais rápido)
        const storePromises = STORES_TO_TRY.map(async (store) => {
            try {
                // Pequeno delay aleatório para evitar rate-limit agressivo se tiver muitas lojas
                await new Promise(r => setTimeout(r, Math.random() * 1000));

                const res: any = await lomadeeTool.execute({ 
                    context: { keyword, limit: 10, sort: "relevance", storeId: store.id }, 
                    mastra 
                });
                
                if (res?.products && res.products.length > 0) {
                    // Filtro de Coerência: Nome do produto deve conter parte da busca
                    const validItems = res.products.filter((p: any) => 
                        p.name.toLowerCase().includes(mainKeyword) && p.price > 20 // Filtra itens muito baratos/erros
                    );
                    return validItems;
                }
            } catch (e) { 
                // Erro silencioso por loja para não quebrar o fluxo todo
                // console.error(`Erro na loja ${store.name}:`, e); 
            }
            return [];
        });

        const results = await Promise.all(storePromises);
        results.forEach(items => allProducts.push(...items));
    }

    // 4. Limpeza Final (Deduplicação e Embaralhamento)
    // Remove duplicatas baseadas no ID único do produto
    const uniqueProducts = Array.from(new Map(allProducts.map(item => [item.id, item])).values());
    
    // Embaralha para que não fiquem agrupados por categoria (ex: não postar 5 geladeiras seguidas)
    const shuffled = uniqueProducts.sort(() => 0.5 - Math.random());

    console.log(`✅ CICLO CONCLUÍDO: ${uniqueProducts.length} produtos únicos encontrados.`);
    return { success: shuffled.length > 0, products: shuffled };
  },
});

// --- PASSO 2: FILTRAGEM DE JÁ POSTADOS ---
const filterStep = createStep({
  id: "filter-products",
  inputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  outputSchema: z.object({ success: z.boolean(), newProducts: z.array(ProductSchema) }),
  execute: async ({ inputData }) => {
    if (!inputData.success || inputData.products.length === 0) return { success: false, newProducts: [] };
    
    const candidates = inputData.products;
    const ids = candidates.map(p => p.id);
    
    if (ids.length === 0) return { success: false, newProducts: [] };

    // Monta query dinâmica
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");

    try {
        const res = await pool.query(`SELECT product_id_unique FROM posted_products WHERE product_id_unique IN (${placeholders})`, ids);
        const postedSet = new Set(res.rows.map((r: any) => r.product_id_unique));
        
        const newProducts = candidates.filter(p => !postedSet.has(p.id));
        
        // LIMITADOR: Pega apenas os 3 melhores para não floodar o canal de uma vez
        // Na próxima execução do cron, ele pegará outros.
        const finalSelection = newProducts.slice(0, 3);
        
        console.log(`🛡️ Filtragem: ${candidates.length} candidatos -> ${newProducts.length} inéditos -> ${finalSelection.length} selecionados para agora.`);
        return { success: finalSelection.length > 0, newProducts: finalSelection };
    } catch (e) { 
        console.error("Erro no filtro DB:", e);
        return { success: false, newProducts: [] }; 
    }
  }
});

// --- PASSO 3: GERAÇÃO DE TEXTO (COPY) ---
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
        // Prompt otimizado para conversão
        const prompt = `
        Aja como um canal de ofertas VIP.
        Produto: ${p.name}
        Loja: ${p.store}
        Preço: ${price}
        Link: ${p.link}
        
        Crie uma legenda curta (max 3 linhas) e chamativa. Use emojis de alerta (🚨, 🔥).
        Destaque o preço. Não coloque hashtags.
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
        if (!token || !chat) {
            console.error("❌ Credenciais do Telegram ausentes.");
            break;
        }

        const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(p.price);
        let text = p.generatedMessage || `🔥 *OFERTA ENCONTRADA!*\n\n📦 ${p.name}\n💰 *${priceFormatted}*\n🏬 ${p.store}`;
        
        // Garante que o link esteja presente se a IA esqueceu
        if (!text.includes("http")) text += `\n\n👇 *COMPRE AQUI:*\n${p.link}`;

        // Adiciona botão/link extra para Amazon se configurado
        if (amazonTag) {
            const amazonLink = `https://www.amazon.com.br/s?k=${encodeURIComponent(p.name)}&tag=${amazonTag}`;
            text += `\n\n🔎 [Ver similar na Amazon](${amazonLink})`;
        }

        const body: any = { 
            chat_id: chat, 
            parse_mode: "Markdown", 
            text: text,
            // Adiciona botão inline (mais profissional)
            reply_markup: {
                inline_keyboard: [[{ text: "🛒 IR PARA A LOJA", url: p.link }]]
            }
        };

        if (p.image) { 
            body.photo = p.image; 
            body.caption = text; 
            delete body.text; 
        }

        try {
            const endpoint = p.image ? "sendPhoto" : "sendMessage";
            const res = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            
            if (res.ok) {
                await pool.query(`INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p.id, p.name]);
                count++;
                console.log(`📢 Postado com sucesso: ${p.name}`);
                // Delay de segurança entre posts (evita flood)
                await new Promise(r => setTimeout(r, 8000));
            } else {
                console.error(`Erro API Telegram: ${res.statusText}`);
            }
        } catch (e) { console.error("Erro Conexão Telegram:", e); }
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
