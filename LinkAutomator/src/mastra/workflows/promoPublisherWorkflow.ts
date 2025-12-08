import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";
import { lomadeeTool } from "../tools/lomadeeTool";
import { mercadolivreTool } from "../tools/mercadolivreTool";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    const client = await pool.connect();
    
    // Cria tabela se não existir
    await client.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        product_id_unique VARCHAR(255) UNIQUE NOT NULL,
        product_name TEXT,
        posted_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Banco de dados atualizado com sucesso!");
    client.release();
  } catch (err) { console.error("❌ Erro DB:", err); }
}

setupDatabase();

const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  link: z.string(),
  image: z.string().optional(),
  store: z.string().optional(),
  generatedMessage: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

// --- LISTA CORRIGIDA (SEM ASPAS QUEBRADAS) ---
const KEYWORDS = [
  "Smartphone Android", "iPhone", "Tablet 10", "Notebook gamer", "Notebook ultrafino", 
  "Smartwatch", "Pulseira inteligente", "Monitor 27", "Teclado mecânico", "Mouse gamer", 
  "Mouse sem fio", "Headset Bluetooth", "Caixa de som portátil", "TV 4K", "TV 8K", 
  "Chromecast", "Fire TV Stick", "Roteador Wi-Fi 6", "SSD NVMe", "HD externo", 
  "Pendrive 128GB", "Placa de vídeo", "Processador Intel", "Processador AMD", 
  "Memória RAM 16GB", "Fonte de alimentação", "Gabinete gamer", "Webcam Full HD", 
  "Impressora", "Scanner", "Microfone condensador", "Ring light", "Tripé extensível", 
  "Drone recreativo", "Drone profissional", "Câmera DSLR", "Câmera mirrorless", 
  "Lente 50mm", "Lente telefoto", "Cartão SD 128GB", "Console PlayStation", 
  "Console Xbox", "Console Nintendo Switch", "Controle sem fio", "Volante gamer", 
  "Jogo de tabuleiro", "Jogo de cartas", "Livro físico", "E-book reader", 
  "Caderno universitário", "Caneta esferográfica", "Caneta gel", "Marca-texto", 
  "Mochila", "Estojo", "Agenda", "Calculadora científica", "Papel sulfite", 
  "Garrafa térmica", "Copo térmico", "Liquidificador", "Airfryer", "Fogão", 
  "Geladeira", "Micro-ondas", "Cafeteira", "Torradeira", "Mixer", "Ferro de passar", 
  "Aspirador de pó", "Lavadora de roupas", "Secadora", "Ventilador", "Ar-condicionado", 
  "Purificador de ar", "Fone de ouvido", "Tênis esportivo", "Chinelo", "Sandália feminina", 
  "Calça jeans", "Blusa social", "Camiseta básica", "Moletom", "Jaqueta", "Bermuda", 
  "Vestido", "Saia", "Boné", "Relógio de pulso", "Pulseira de couro", "Óculos de sol", 
  "Colar", "Anel", "Brinco", "Shampoo", "Condicionador", "Sabonete líquido", 
  "Hidratante corporal", "Perfume masculino", "Perfume feminino", "Desodorante", 
  "Escova de dente elétrica", "Creme dental", "Protetor solar", "Protetor labial", 
  "Ração para cachorro", "Ração para gato", "Areia sanitária", "Brinquedo para pet", 
  "Coleira", "Comedouro", "Bebedouro automático", "Suplemento vitamínico", 
  "Barra de proteína", "Whey protein", "Creatina", "Pré-treino", "Tênis de corrida", 
  "Bola de futebol", "Bola de vôlei", "Bicicleta", "Capacete", "Trava de bike", 
  "Skate", "Patins in-line", "Mochila de hidratação", "Tenda de camping", 
  "Saco de dormir", "Lanterna LED", "Fogareiro portátil"
];

// Passo 1: Busca Híbrida
const fetchHybridStep = createStep({
  id: "fetch-hybrid",
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), products: z.array(ProductSchema) }),
  execute: async ({ mastra }) => {
    console.log("🚀 [Passo 1] Iniciando Busca Híbrida...");
    
    const keyword = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
    console.log(`🔎 Buscando por: "${keyword}"`);

    let allProducts: Product[] = [];

    // --- 1. TENTA LOMADEE ---
    try {
        // Chamada direta da tool importada
        const res: any = await lomadeeTool.execute({ 
            context: { keyword, limit: 3, sort: "discount" },
            mastra 
        });
        
        if (res?.products) {
            allProducts.push(...res.products.map((p: any) => ({
                ...p, 
                store: p.store || "Loja Parceira (Lomadee)"
            })));
            console.log(`📦 Lomadee trouxe: ${res.products.length} itens.`);
        }
    } catch (e) { 
        console.error("Erro Lomadee:", e); 
    }

    // --- 2. TENTA MERCADO LIVRE ---
    try {
        // Chamada direta da tool importada
        const res: any = await mercadolivreTool.execute({ 
            context: { keyword, limit: 3 },
            mastra 
        });
        
        if (res?.products) {
            const mlProducts = res.products.map((p: any) => ({
                id: `MLB-${p.id}`, 
                name: p.name,
                price: p.price,
                link: p.link,
                image: p.image,
                store: "Mercado Livre"
            }));
            allProducts.push(...mlProducts);
            console.log(`📦 Mercado Livre trouxe: ${mlProducts.length} itens.`);
        }
    } catch (e) { 
        console.error("Erro ML:", e); 
    }

    const uniqueProducts = Array.from(new Map(allProducts.map(item => [item.id, item])).values());
    
    console.log(`✅ TOTAL FINAL: ${uniqueProducts.length} produtos.`);
    return { success: uniqueProducts.length > 0, products: uniqueProducts };
  },
});

// Passo 2: Filtro Anti-Repetição
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
        const res = await pool.query(
            `SELECT product_id_unique FROM posted_products WHERE product_id_unique IN (${placeholders})`, 
            ids
        );
        const posted = new Set(res.rows.map((r: any) => r.product_id_unique));
        const newProducts = candidates.filter(p => !posted.has(p.id));
        
        console.log(`✅ Filtrados: ${newProducts.length} novos para postar.`);
        return { success: true, newProducts: newProducts.slice(0, 3) };
    } catch (e) {
        console.error("Erro Filtro:", e);
        return { success: false, newProducts: [] };
    }
  }
});

// Passo 3: IA Gera o Texto
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
        const prompt = `Crie post Telegram. Produto: ${p.name}. Preço: ${price}. Loja: ${p.store}. Link: ${p.link}. Use emojis.`;
        try {
            const res = await agent?.generateLegacy([{ role: "user", content: prompt }]);
            p.generatedMessage = res?.text || "";
        } catch { p.generatedMessage = ""; }
    }));
    return { success: true, enrichedProducts };
  }
});

// Passo 4: Publicar
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
        if (!token || !chat) continue;
        
        let text = p.generatedMessage || `🔥 ${p.name}\n💰 R$ ${p.price}\n👇 ${p.link}`;
        if (!text.includes("http")) text += `\n${p.link}`;

        const body: any = { chat_id: chat, parse_mode: "Markdown", text: text };
        if (p.image) {
            body.photo = p.image;
            body.caption = text;
            delete body.text;
        }

        try {
            await fetch(`https://api.telegram.org/bot${token}/${p.image ? "sendPhoto" : "sendMessage"}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            await pool.query(
                `INSERT INTO posted_products (product_id_unique, product_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, 
                [p.id, p.name]
            );
            count++;
            console.log(`📢 Postado: ${p.name}`);
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
  .then(fetchHybridStep)
  .then(filterStep)
  .then(copyStep)
  .then(publishStep)
  .commit();
