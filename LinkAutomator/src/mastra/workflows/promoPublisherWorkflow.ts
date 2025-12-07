import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Configuração do Banco de Dados
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

// Schema do Produto
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
  // Campo novo para guardar o texto gerado pela IA
  generatedMessage: z.string().optional(), 
});

type Product = z.infer<typeof ProductSchema>;

// Passo 1: Buscar Produtos
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
      const params = new URLSearchParams({ page: "1", limit: "20", sort: "discount" }); // Ordenar por desconto
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
        store: item.store || item.storeName || "",
        category: item.category || "",
        generatedMessage: "", // Inicializa vazio
      }));

      return { success: products.length > 0, products };
    } catch (error) {
      return { success: false, products: [], error: String(error) };
    }
  },
});

// Passo 2: Filtrar Produtos
const filterNewProductsStep = createStep({
  id: "filter-new-products",
  description: "Filters out products that have already been posted",
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
      
      // Filtra e pega apenas os TOP 3 produtos novos para não gastar muita IA/Quota de uma vez
      const newProducts = inputData.products
        .filter((p) => !postedIds.has(p.id))
        .slice(0, 3); 

      return { success: true, newProducts, alreadyPostedCount: result.rowCount || 0 };
    } catch (error) {
      console.error("Erro filtro:", error);
      return { success: false, newProducts: [], alreadyPostedCount: 0 };
    }
  },
});

// Passo 3: Gerar Texto com IA (NOVO)
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
      
      // Prompt específico para garantir que o preço apareça
      const prompt = `
        Crie uma legenda curta e urgente para postar este produto no Telegram.
        
        DADOS DO PRODUTO:
        - Nome: ${product.name}
        - Loja: ${product.store || "Parceiro"}
        - Preço OFICIAL: ${priceFormatted} (OBRIGATÓRIO INCLUIR NO TEXTO)
        - Link: ${product.link}
        
        REGRAS:
        1. Comece com um Headline chamativo (ex: "🔥 BAIXOU!", "🚨 ERRO DE PREÇO?").
        2. Seja breve e direto (máximo 3 linhas de descrição).
        3. Use emojis relevantes.
        4. OBRIGATÓRIO: O preço (${priceFormatted}) deve estar bem visível.
        5. Finalize com uma chamada para ação (CTA) apontando para o link.
        6. NÃO coloque o link no texto, apenas indique onde clicar (o link vai num botão ou no final).
      `;

      try {
        const result = await agent?.generate(prompt);
        // Se a geração falhar, usa um fallback simples
        product.generatedMessage = result?.text || `🔥 Oferta: ${product.name}\n💰 Por apenas: ${priceFormatted}`;
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
    // Se a IA falhou ou veio vazio, garante um texto base com o preço
    let caption = product.generatedMessage;
    const priceFormatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price);

    if (!caption || !caption.includes("R$")) {
        caption = `🔥 *OFERTA!*\n${product.name}\n\n💰 *${priceFormatted}*\n\n👇 Toque no link abaixo:`;
    }

    // Adiciona o link no final do texto se a IA não tiver colocado (para garantir)
    caption += `\n\n🛒 [COMPRAR AGORA](${product.link})`;

    const endpoint = product.image ? "sendPhoto" : "sendMessage";
    const body: any = {
      chat_id: channelId,
      parse_mode: "Markdown", // Cuidado com caracteres especiais no texto da IA
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
        // Se falhar por Markdown, tenta enviar sem formatação (fallback seguro)
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

// Passo 4: Publicar (Agora usando 'enrichedProducts')
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
        console.log(`✅ Enviado: ${product.name}`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    return {
      success: true,
      publishedCount,
      summary: `Publicados ${publishedCount} produtos com sucesso.`,
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
  .then(generateCopyStep) // <--- Novo passo de IA aqui
  .then(publishProductsStep)
  .commit();
