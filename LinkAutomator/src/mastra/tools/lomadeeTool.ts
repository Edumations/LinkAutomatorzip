import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee com ID composto por loja",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(12),
    sort: z.string().optional().default("relevance"),
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
        console.error("❌ [Lomadee] ERRO: Variável LOMADEE_API_KEY ausente.");
        return { products: [] };
    }

    const parsePrice = (value: any): number => {
        if (!value) return 0;
        if (typeof value === 'number') return value;
        try {
            let str = String(value).trim();
            str = str.replace(/[^\d.,]/g, ""); 
            if (str.includes(",") && str.includes(".")) str = str.replace(/\./g, "").replace(",", ".");
            else if (str.includes(",")) str = str.replace(",", ".");
            return parseFloat(str) || 0;
        } catch { return 0; }
    };

    try {
      const params = new URLSearchParams({
        keyword: context.keyword,
        size: String(context.limit || 12),
        sort: context.sort || "relevance"
      });

      if (sourceId) params.append("sourceId", sourceId);
      if (context.storeId) params.append("storeId", context.storeId);

      const res = await fetch(`https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`, { 
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" } 
      });

      if (!res.ok) {
          console.log(`⚠️ [Lomadee] API retornou erro ${res.status} para loja ${context.storeId || "Geral"}`);
          return { products: [] };
      }

      const data: any = await res.json();
      const rawProducts = data.data || data.products || [];

      const products = rawProducts.map((item: any) => {
        // Preço
        let finalPrice = parsePrice(item.price) || parsePrice(item.salePrice) || parsePrice(item.priceMin);
        if (finalPrice === 0 && item.options?.[0]) {
            finalPrice = parsePrice(item.options[0].price) || parsePrice(item.options[0].salePrice);
        }

        // Imagem
        let finalImage = item.thumbnail || item.image || item.picture;
        if (!finalImage && item.options?.[0]?.images?.[0]) {
             finalImage = item.options[0].images[0].url || item.options[0].images[0].medium;
        }

        // Loja e ID
        const storeName = item.store?.name || item.storeName || "Oferta";
        // TRUQUE DE MESTRE: O ID agora inclui a loja. Isso evita que o iPhone da Amazon bloqueie o iPhone da Magalu.
        const uniqueId = `${item.id || item.productId}-${storeName.replace(/\s+/g, '')}`;

        return {
            id: uniqueId,
            name: item.name || item.productName || context.keyword,
            price: finalPrice,
            link: item.link || item.url || "",
            image: finalImage || "",
            store: storeName
        };
      });

      // Filtra itens inválidos (sem preço ou link)
      return { products: products.filter((p: any) => p.price > 0 && p.link) };

    } catch (e) {
      return { products: [] };
    }
  }
});
