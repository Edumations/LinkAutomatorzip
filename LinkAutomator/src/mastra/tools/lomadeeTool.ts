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

    // Conversor de preço SUPER agressivo
    const parsePrice = (value: any): number => {
        if (!value) return 0;
        if (typeof value === 'number') return value;
        
        // Converte para string e limpa sujeira
        let str = String(value).trim();
        
        // Se vier como "R$ 1.200,50" -> Tira R$ e espaços
        str = str.replace(/[^\d.,]/g, ""); 

        // Lógica Brasileira: Se tem vírgula no final (ex: 100,50 ou 1.000,00)
        if (str.includes(",")) {
            // Remove pontos de milhar (1.000 -> 1000)
            str = str.replace(/\./g, "");
            // Troca vírgula decimal por ponto (1000,50 -> 1000.50)
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

      console.log(`📡 [Lomadee] Buscando: ${context.keyword} (Loja ID: ${context.storeId || "Geral"})`);

      const res = await fetch(
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
      );

      if (!res.ok) return { products: [] };

      const data = await res.json();
      const rawProducts = data.data || [];

      const products = rawProducts.map((item: any) => {
        // TENTA ACHAR PREÇO EM TUDO QUE É LUGAR
        let finalPrice = parsePrice(item.price);
        
        if (finalPrice === 0) finalPrice = parsePrice(item.salePrice);
        if (finalPrice === 0) finalPrice = parsePrice(item.priceMin); // Comum em marketplaces
        if (finalPrice === 0) finalPrice = parsePrice(item.priceMax);
        if (finalPrice === 0 && item.installment) finalPrice = parsePrice(item.installment.price);

        // --- DIAGNÓSTICO DE ERRO ---
        // Se ainda for zero, imprime o item bruto para descobrirmos o problema
        if (finalPrice === 0) {
             console.log("🚨 [DEBUG] ITEM COM PREÇO ZERO ENCONTRADO:");
             console.log(JSON.stringify(item, null, 2)); // Mostra o JSON puro
        }
        // ---------------------------

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
