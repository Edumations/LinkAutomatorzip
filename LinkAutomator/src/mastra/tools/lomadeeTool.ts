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

    // --- CORREÇÃO DO PREÇO ---
    const parsePrice = (value: any): number => {
        if (typeof value === 'number') return value;
        if (!value) return 0;
        
        // Remove tudo que não é número, ponto ou vírgula
        let str = String(value).replace(/[^\d.,]/g, "").trim();

        // Lógica para Brasil (1.000,00) vs EUA (1,000.00)
        if (str.includes(",") && str.includes(".")) {
            // Formato 1.234,50 -> Remove ponto, troca vírgula por ponto
            str = str.replace(/\./g, "").replace(",", ".");
        } else if (str.includes(",")) {
            // Formato 1234,50 -> Troca vírgula por ponto
            str = str.replace(",", ".");
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

      console.log(`📡 [Lomadee] Buscando: ${context.keyword} (Loja: ${context.storeId || "Geral"})`);

      const res = await fetch(
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
      );

      if (!res.ok) return { products: [] };

      const data = await res.json();
      const rawProducts = data.data || [];

      // Mapeamento com Debug de Preço
      const products = rawProducts.map((item: any) => {
        // Tenta achar o preço em qualquer campo
        let finalPrice = parsePrice(item.price);
        if (finalPrice === 0) finalPrice = parsePrice(item.salePrice);
        if (finalPrice === 0) finalPrice = parsePrice(item.priceFrom);
        if (finalPrice === 0 && item.installment) finalPrice = parsePrice(item.installment.price);

        // Se ainda for zero, imprime no log para descobrirmos o motivo
        if (finalPrice === 0) {
             // console.log(`⚠️ Preço Zero no item: ${item.name} | Raw: ${JSON.stringify(item.price || item.salePrice)}`);
        }

        return {
            id: String(item.id || item.productId),
            name: item.name || item.productName,
            price: finalPrice,
            link: item.link || item.url,
            image: item.thumbnail || item.image || "",
            store: item.store?.name || item.storeName || "Lomadee"
        };
      });

      return { products };

    } catch (e) {
      console.error("❌ [Lomadee Exception]", e);
      return { products: [] };
    }
  }
});
