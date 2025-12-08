import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee com validação flexível",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(12),
    sort: z.string().optional().default("relevance"),
    storeId: z.string().nullish(), // Aceita null ou undefined sem erro
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

    // Diagnóstico claro se faltar chave
    if (!apiKey) {
        console.error("❌ [Lomadee Tool] ERRO: Variável LOMADEE_API_KEY não configurada no Render.");
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
      // Só adiciona storeId se ele realmente existir e não for "undefined" string
      if (context.storeId && context.storeId !== "undefined") {
          params.append("storeId", context.storeId);
      }

      // Log para debug (oculta a API Key por segurança)
      console.log(`📡 [Lomadee] GET: ...${params.toString().slice(-30)}`);

      const res = await fetch(`https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`, { 
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" } 
      });

      if (!res.ok) {
          const errBody = await res.text();
          console.error(`⚠️ [Lomadee API] Erro ${res.status}: ${errBody.slice(0, 100)}`);
          return { products: [] };
      }

      const data: any = await res.json();
      const rawProducts = data.data || data.products || [];

      const products = rawProducts.map((item: any) => {
        // Preço: varredura completa
        let finalPrice = parsePrice(item.price) || parsePrice(item.salePrice) || parsePrice(item.priceMin);
        if (finalPrice === 0 && item.options?.[0]) {
            finalPrice = parsePrice(item.options[0].price) || parsePrice(item.options[0].salePrice);
        }

        // Imagem: varredura completa
        let finalImage = item.thumbnail || item.image || item.picture;
        if (!finalImage && item.options?.[0]?.images?.[0]) {
             finalImage = item.options[0].images[0].url || item.options[0].images[0].medium;
        }

        const storeName = item.store?.name || item.storeName || "Oferta";
        // ID COMPOSTO: Garante que o mesmo produto em lojas diferentes conte como 2 ofertas
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

      return { products: products.filter((p: any) => p.price > 0 && p.link) };

    } catch (e) {
      console.error("❌ [Lomadee Exception]", e);
      return { products: [] };
    }
  }
});
