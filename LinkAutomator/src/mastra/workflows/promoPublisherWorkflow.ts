import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function setupDatabase() {
  if (!process.env.DATABASE_URL) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posted_products (
        id SERIAL PRIMARY KEY,
        lomadee_product_id VARCHAR(255) UNIQUE NOT NULL,
        product_name TEXT,
        product_link TEXT,
        product_price DECIMAL(10, 2),
        posted_telegram BOOLEAN DEFAULT FALSE,
        posted_at TIMESTAMP DEFAULT NOW()
      );
    `);
  } catch (err) {
    console.error("❌ Erro fatal ao criar tabela:", err);
  }
}

setupDatabase();

const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  originalPrice: z.number().optional(),
  discount: z.number().optional(),
  link: z.string(),
  image: z.string().optional(),
  store: z.string().optional(),
  category: z.string().optional(),
  generatedMessage: z.string().optional(),
});

type Product = z.infer<typeof ProductSchema>;

// Passo 1: Buscar Produtos (AUMENTADO O LIMITE)
const fetchProductsStep = createStep({
  id: "fetch-lomadee-products",
  description: "Fetches promotional products from the Lomadee API",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),
  execute: async ({ mastra }) => {
    const apiKey = process.env.LOMADEE_API_KEY;
    if (!apiKey) return { success: false, products: [], error: "Missing LOMADEE_API_KEY" };

    try {
      // AUMENTADO DE 20 PARA 60 para ter mais variedade
      const params = new URLSearchParams({ page: "1", limit: "60", sort: "discount" });
      const response = await fetch(
        `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
        {
          method: "GET",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        }
      );

      if (!response.ok) {
        return { success: false, products: [], error: `API Error: ${response.status}` };
      }

      const data = await response.json();
      
      const products: Product[] = (data.data || []).map((item: any) => ({
        id: String(item.id || item.productId || Math.random().toString(36)),
        name: item.name || item.productName || "Produto sem nome",
        price: parseFloat(item.price || item.salePrice || 0),
        originalPrice: parseFloat(item.originalPrice || item.price || 0),
        discount: item.discount || 0,
        link: item.link || item.url || "",
        image: item.image || item.thumbnail || "",
        store: item.store || item.storeName || "Loja Parceira",
        category: item.category || item.categoryName || "Geral",
        generatedMessage: "",
      }));

      return { success: products.length > 0, products };
    } catch (error) {
      return { success: false, products: [], error: String(error) };
    }
  },
});

// Passo 2: Filtrar com DIVERSIDADE
const filterNewProductsStep = createStep({
  id: "filter-new-products",
  description: "Filters new products prioritizing diversity of stores and categories",
  inputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    error: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    newProducts: z.array(ProductSchema),
    alreadyPostedCount: z.number(),
    error: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.success || inputData.products.length === 0) {
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }

    try {
      const productIds = inputData.products.map((p) => p.id);
      if (productIds.length === 0) return { success: true, newProducts: [], alreadyPostedCount: 0 };

      const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ");
      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        productIds
      );

      const postedIds = new Set(result.rows.map((row: any) => row.lomadee_product_id));
      
      // Lista de todos os produtos novos disponíveis
      const availableProducts = inputData.products.filter((p) => !postedIds.has(p.id));
      const alreadyPostedCount = inputData.products.length - availableProducts.length;

      // --- LÓGICA DE DIVERSIDADE ---
      const selectedProducts: Product[] = [];
      const usedStores = new Set<string>();
      const usedCategories = new Set<string>();
      const MAX_SELECTION = 3;

      // 1. Tenta pegar produtos que tenham LOJA E CATEGORIA inéditas nesta rodada
      for (const product of availableProducts) {
        if (selectedProducts.length >= MAX_SELECTION) break;

        const storeKey = product.store || "unknown";
        const catKey = product.category || "unknown";

        if (!usedStores.has(storeKey) && !usedCategories.has(catKey)) {
          selectedProducts.push(product);
          usedStores.add(storeKey);
          usedCategories.add(catKey);
        }
      }

      // 2. Se não encheu os 3 slots, relaxa a regra: aceita repetir categoria, mas evita loja
      if (selectedProducts.length < MAX_SELECTION) {
        for (const product of availableProducts) {
          if (selectedProducts.length >= MAX_SELECTION) break;
          // Se o produto já foi selecionado no passo 1, ignora
          if (selectedProducts.some(p => p.id === product.id)) continue;

          const storeKey = product.store || "unknown";
          if (!usedStores.has(storeKey)) {
             selectedProducts.push(product);
             usedStores.add(storeKey);
          }
        }
      }

      // 3. Se ainda assim sobrar espaço, preenche com qualquer um que sobrou (para garantir postagens)
      if (selectedProducts.length < MAX_SELECTION) {
        for (const product of availableProducts) {
          if (selectedProducts.length >= MAX_SELECTION) break;
          if (!selectedProducts.some(p => p.id === product.id)) {
             selectedProducts.push(product);
          }
        }
      }

      console.log(`🔎 [DIVERSIDADE] Selecionados: ${selectedProducts.map(p => `${p.store} - ${p.category}`).join(" | ")}`);

      return { success: true, newProducts: selectedProducts, alreadyPostedCount };
    } catch (error) {
      console.error("Erro filtro:", error);
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }
  },
});

// Passo 3: Gerar Texto com IA
const generateCopyStep = createStep({
  id: "generate-copy",
  description: "Uses AI to write persuasive copy for the products",
  inputSchema: z.object({
    success: z.boolean(),
    newProducts: z.array(ProductSchema),
    alreadyPostedCount: z.number(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    enrichedProducts: z.array(ProductSchema),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData.success || inputData.newProducts.length === 0) {
      return { success: true, enrichedProducts: [] };
    }

    const agent = mastra?.getAgent("promoPublisherAgent");
    const enrichedProducts = [...inputData.newProducts];

    console.log(`🤖 Gerando textos para ${enrichedProducts.length} produtos...`);

    for (let i = 0; i < enrichedProducts.length; i++) {
      const product = enrichedProducts[i];
      const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);
      
      const prompt = `
        Crie uma legenda curta e urgente para postar este produto no Telegram.
        
        DADOS:
        - Produto: ${product.name}
        - Loja: ${product.store || "Parceiro"}
        - Categoria: ${product.category}
        - Preço: ${priceFormatted} (OBRIGATÓRIO NO TEXTO)
        - Link: ${product.link}
        
        REGRAS:
        1. Headline com emoji chamativo.
        2. Fale do benefício principal.
        3. Exiba o preço (${priceFormatted}) com destaque.
        4. CTA final.
      `;

      try {
        const result = await agent?.generate(prompt);
        product.generatedMessage = result?.text || `🔥 Oferta: ${product.name}\n💰 ${priceFormatted}`;
      } catch (error) {
        console.error(`Erro IA produto ${product.id}:`, error);
        product.generatedMessage = `🔥 ${product.name}\n💰 ${priceFormatted}`;
      }
    }

    return { success: true, enrichedProducts };
  },
});

// Funções Auxiliares de Envio
async function sendTelegramMessage(product: Product, logger: any): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!botToken || !channelId) return false;

  try {
    let caption = product.generatedMessage;
    const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);

    if (!caption || !caption.includes("R$")) {
        caption = `🔥 *OFERTA!*\n${product.name}\n\n💰 *${priceFormatted}*\n\n👇 Link abaixo:`;
    }

    caption += `\n\n🛒 [COMPRAR AGORA](${product.link})`;

    const endpoint = product.image ? "sendPhoto" : "sendMessage";
    const body: any = {
      chat_id: channelId,
      parse_mode: "Markdown",
      disable_web_page_preview: false
    };

    if (product.image) {
      body.photo = product.image;
      body.caption = caption;
    } else {
      body.text = caption;
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!data.ok) {
        console.warn("Falha no Markdown, tentando texto puro...");
        if (product.image) body.parse_mode = undefined;
        else { body.parse_mode = undefined; body.text = `${product.name} - ${priceFormatted}\n${product.link}`; }
        
        await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
    }

    return true;
  } catch (error) {
    console.error("Erro Telegram:", error);
    return false;
  }
}

async function markProductAsPosted(product: Product): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO posted_products 
       (lomadee_product_id, product_name, product_link, product_price, posted_telegram, posted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (lomadee_product_id) DO UPDATE SET posted_telegram = TRUE, posted_at = NOW()`,
      [product.id, product.name, product.link, product.price, true]
    );
  } catch (err) {
    console.error("Erro ao salvar no banco:", err);
  }
}

// Passo 4: Publicar
const publishProductsStep = createStep({
  id: "publish-products",
  description: "Publishes enriched products to Telegram",
  inputSchema: z.object({
    success: z.boolean(),
    enrichedProducts: z.array(ProductSchema),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    publishedCount: z.number(),
    summary: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    
    if (!inputData.success || inputData.enrichedProducts.length === 0) {
      return { success: true, publishedCount: 0, summary: "Nenhum produto novo." };
    }

    let publishedCount = 0;
    
    for (const product of inputData.enrichedProducts) {
      const sent = await sendTelegramMessage(product, logger);
      if (sent) {
        await markProductAsPosted(product);
        publishedCount++;
        console.log(`✅ Enviado: ${product.name} (${product.store})`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    return {
      success: true,
      publishedCount,
      summary: `Publicados ${publishedCount} produtos variados.`,
    };
  },
});

export const promoPublisherWorkflow = createWorkflow({
  id: "promo-publisher-workflow",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    publishedCount: z.number(),
    summary: z.string(),
  }),
})
  .then(fetchProductsStep)
  .then(filterNewProductsStep)
  .then(generateCopyStep)
  .then(publishProductsStep)
  .commit();
