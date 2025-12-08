import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee (API Beta)",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(3),
    sort: z.string().optional().default("discount"),
    storeId: z.string().optional(),
  }),
  outputSchema: z.object({
    products: z.array(z.object({
      id: z.string(),
      name: z.string(),
      price: z.number(),
      link: z.string(),
      image: z.string(),
      store: z.string(),
    })),
  }),
  execute: async ({ context }) => {
    const apiKey = process.env.LOMADEE_API_KEY;
    const sourceId = process.env.LOMADEE_SOURCE_ID;

    if (!apiKey) {
        console.error("❌ [Lomadee] Falta API Key");
        return { products: [] };
    }

    try {
      // Configura os parâmetros para a API Beta (A única estável agora)
      const params = new URLSearchParams({
        keyword: context.keyword,
        limit: String(context.limit || 3),
        sort: context.sort || "discount"
      });

      if (sourceId) params.append("sourceId", sourceId);
      
      // Tenta filtrar por loja se solicitado
      if (context.storeId) params.append("storeId", context.storeId);

      console.log(`📡 [Lomadee] Buscando na API Beta: ${context.keyword} (Loja: ${context.storeId || "Geral"})`);

      // Endereço CORRETO (api-beta.lomadee.com.br)
      const res = await fetch(
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          { 
            headers: { 
                "x-api-key": apiKey, 
                "Content-Type": "application/json" 
            } 
          }
      );

      if (!res.ok) {
          console.error(`❌ [Lomadee Erro] HTTP ${res.status}`);
          return { products: [] };
      }

      const data = await res.json();

      // Mapeia os produtos
      const products = (data.data || []).map((item: any) => ({
        id: String(item.id || item.productId),
        name: item.name || item.productName,
        price: item.price || item.salePrice || 0,
        link: item.link || item.url,
        image: item.thumbnail || item.image || "",
        store: item.store?.name || item.storeName || "Lomadee"
      }));

      return { products };

    } catch (e) {
      console.error("❌ [Lomadee Exception]", e);
      return { products: [] };
    }
  }
});
