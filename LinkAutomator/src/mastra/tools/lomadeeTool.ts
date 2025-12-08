import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee (API Beta)",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(3),
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

    if (!apiKey) return { products: [] };

    // Conversor de preço (Mantido, pois é bom)
    const parsePrice = (value: any): number => {
        if (!value) return 0;
        if (typeof value === 'number') return value;
        let str = String(value).trim();
        str = str.replace(/[^\d.,]/g, ""); 
        if (str.includes(",")) {
            str = str.replace(/\./g, "").replace(",", ".");
        }
        return parseFloat(str) || 0;
    };

    try {
      const params = new URLSearchParams({
        keyword: context.keyword,
        limit: String(context.limit || 3),
        sort: context.sort || "relevance"
      });

      if (sourceId) params.append("sourceId", sourceId);
      if (context.storeId) params.append("storeId", context.storeId);

      console.log(`📡 [Lomadee] Buscando: ${context.keyword} (Loja ID: ${context.storeId || "Geral"})`);

      const res = await fetch(
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
      );

      if (!res.ok) return { products: [] };

      const data = await res.json();
      const rawProducts = data.data || [];

      const products = rawProducts.map((item: any) => {
        let finalPrice = 0;

        // 1. Tenta pegar do padrão (root)
        finalPrice = parsePrice(item.price) || parsePrice(item.salePrice) || parsePrice(item.priceMin) || parsePrice(item.priceMax);

        // 2. CORREÇÃO CRÍTICA: Tenta pegar de dentro de "options" -> "pricing"
        // O JSON do log mostrou que é aqui que o preço real está!
        if (finalPrice === 0 && item.options && item.options.length > 0) {
            const option = item.options[0]; // Pega a primeira opção
            
            // Verifica se tem preço direto na opção
            if (option.price) finalPrice = parsePrice(option.price);

            // Verifica se tem array de pricing (O caso do seu log)
            if (finalPrice === 0 && option.pricing && option.pricing.length > 0) {
                const priceObj = option.pricing[0];
                finalPrice = parsePrice(priceObj.price) || parsePrice(priceObj.salePrice) || parsePrice(priceObj.listPrice);
            }
        }

        // Tenta pegar imagem da opção se a principal falhar
        let finalImage = item.thumbnail || item.image;
        if (!finalImage && item.options && item.options.length > 0) {
            const imgObj = item.options[0].images ? item.options[0].images[0] : null;
            if (imgObj) finalImage = imgObj.url || imgObj.large || imgObj.medium; 
        }

        // Diagnóstico final (só imprime se falhar mesmo depois de tudo isso)
        if (finalPrice === 0) {
             console.log(`🚨 [DEBUG] ITEM AINDA ZERO: ${item.name}`);
        }

        return {
            id: String(item.id || item.productId),
            name: item.name || item.productName,
            price: finalPrice,
            link: item.link || item.url,
            image: finalImage || "",
            store: item.store?.name || item.storeName || item.options?.[0]?.seller || "Lomadee"
        };
      });

      return { products };

    } catch (e) {
      console.error("❌ [Lomadee Exception]", e);
      return { products: [] };
    }
  }
});
