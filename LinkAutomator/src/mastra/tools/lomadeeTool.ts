import { createTool } from "@mastra/core/tools";
import { z } from "zod";

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
});

export type LomadeeProduct = z.infer<typeof ProductSchema>;

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description:
    "Fetches promotional products from Lomadee affiliate API. Use this to get the latest deals and offers from Brazilian e-commerce stores.",

  inputSchema: z.object({
    page: z.number().optional().default(1).describe("Page number for pagination"),
    limit: z.number().optional().default(20).describe("Number of products to fetch (max 100)"),
    keyword: z.string().optional().describe("Optional keyword to filter products"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(ProductSchema),
    totalProducts: z.number(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [LomadeeTool] Starting product fetch", { context });

    const apiKey = process.env.LOMADEE_API_KEY;
    
    if (!apiKey) {
      logger?.error("❌ [LomadeeTool] Missing LOMADEE_API_KEY environment variable");
      return {
        success: false,
        products: [],
        totalProducts: 0,
        error: "Missing LOMADEE_API_KEY configuration",
      };
    }

    try {
      const params = new URLSearchParams({
        page: String(context.page || 1),
        limit: String(Math.min(context.limit || 20, 100)),
      });

      if (context.keyword) {
        params.append("keyword", context.keyword);
      }

      logger?.info("📡 [LomadeeTool] Calling Lomadee API", { params: params.toString() });

      const response = await fetch(
        `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
        {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger?.error("❌ [LomadeeTool] API error", { 
          status: response.status, 
          error: errorText 
        });
        return {
          success: false,
          products: [],
          totalProducts: 0,
          error: `Lomadee API error: ${response.status} - ${errorText}`,
        };
      }

      const data = await response.json();
      logger?.info("📦 [LomadeeTool] Raw API response received", { 
        dataKeys: Object.keys(data),
        hasData: !!data.data,
      });

      const products: LomadeeProduct[] = (data.data || []).map((item: any) => ({
        id: String(item.id || item.productId || Math.random().toString(36)),
        name: item.name || item.title || item.productName || "Produto sem nome",
        price: parseFloat(item.price || item.salePrice || item.priceFrom || 0),
        originalPrice: parseFloat(item.originalPrice || item.priceFrom || item.price || 0),
        discount: item.discount || item.discountPercent || 0,
        link: item.link || item.url || item.deepLink || item.affiliateLink || "",
        image: item.image || item.thumbnail || item.imageUrl || "",
        store: item.store || item.storeName || item.advertiser || "",
        category: item.category || item.categoryName || "",
      }));
      // 🔴 COLE O CÓDIGO DE DIAGNÓSTICO AQUI 🔴
console.log("========================================");
console.log(`🔎 [DIAGNÓSTICO] A API da Lomadee retornou: ${products.length} produtos.`);
if (products.length === 0) console.log("⚠️ Lista vazia! Verifique se a categoria tem ofertas hoje.");
console.log("========================================");
// 🔴 FIM DO CÓDIGO 🔴

      logger?.info("✅ [LomadeeTool] Products fetched successfully", { 
        count: products.length 
      });

      return {
        success: true,
        products,
        totalProducts: data.meta?.total || products.length,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [LomadeeTool] Exception occurred", { error: errorMessage });
      
      return {
        success: false,
        products: [],
        totalProducts: 0,
        error: `Failed to fetch products: ${errorMessage}`,
      };
    }
  },
});
