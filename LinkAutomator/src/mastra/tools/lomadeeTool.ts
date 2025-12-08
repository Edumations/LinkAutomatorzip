import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(3),
    sort: z.string().optional().default("discount"),
    storeId: z.string().optional(), // Aceita ID específico
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

    if (!apiKey) return { products: [] };

    try {
      const params = new URLSearchParams({
        keyword: context.keyword,
        sort: context.sort || "discount",
        size: String(context.limit || 3)
      });

      if (sourceId) params.append("sourceId", sourceId);
      // Se tiver ID de loja, força a busca nela
      if (context.storeId) params.append("storeId", context.storeId);

      // Usando endpoint v3 padrão
      const res = await fetch(
        `https://api.lomadee.com/v3/${process.env.LOMADEE_APP_ID || "15769665116712a4b51a"}/product/_search?${params.toString()}`,
        { method: "GET" } 
      );
      
      let data = await res.json();
      
      // Se a v3 falhar ou vier vazia, tenta a API beta (fallback)
      if (!data.products || data.products.length === 0) {
          const paramsBeta = new URLSearchParams({
            keyword: context.keyword,
            limit: String(context.limit || 3),
            sort: context.sort || "discount"
          });
          if (sourceId) paramsBeta.append("sourceId", sourceId);
          if (context.storeId) paramsBeta.append("storeId", context.storeId);

          const resBeta = await fetch(
              `https://api-beta.lomadee.com.br/affiliate/products?${paramsBeta.toString()}`,
              { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
          );
          if (resBeta.ok) {
             const dataBeta = await resBeta.json();
             // Normaliza dados da Beta para parecer com a v3
             if (dataBeta.data) {
                 return {
                     products: dataBeta.data.map((item: any) => ({
                        id: item.id || item.productId,
                        name: item.name || item.productName,
                        price: item.price || item.salePrice || 0,
                        link: item.link || item.url,
                        image: item.thumbnail || item.image || "",
                        store: item.store?.name || item.storeName || "Lomadee"
                     }))
                 };
             }
          }
      }

      const products = (data.products || []).map((item: any) => ({
        id: String(item.id),
        name: item.name,
        price: item.price,
        link: item.link,
        image: item.thumbnail,
        store: item.store?.name || "Lomadee"
      }));

      return { products };
    } catch (e) {
      console.error("Erro Lomadee Tool:", e);
      return { products: [] };
    }
  }
});
