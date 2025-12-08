import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee com Diagnóstico Avançado",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(10),
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

    // Validação inicial de Ambiente
    if (!apiKey) {
        console.error("❌ [Lomadee] ERRO CRÍTICO: Variável LOMADEE_API_KEY não definida.");
        return { products: [] };
    }
    if (!sourceId) {
        console.warn("⚠️ [Lomadee] AVISO: Variável LOMADEE_SOURCE_ID não definida. A maioria das buscas falhará sem ela.");
    }

    const parsePrice = (value: any): number => {
        if (!value) return 0;
        if (typeof value === 'number') return value;
        try {
            let str = String(value).trim();
            // Remove tudo que não é dígito, ponto ou vírgula
            str = str.replace(/[^\d.,]/g, ""); 
            // Corrige formato brasileiro (1.000,00 -> 1000.00)
            if (str.includes(",") && str.includes(".")) {
                str = str.replace(/\./g, "").replace(",", ".");
            } else if (str.includes(",")) {
                str = str.replace(",", ".");
            }
            return parseFloat(str) || 0;
        } catch { return 0; }
    };

    try {
      const params = new URLSearchParams({
        keyword: context.keyword,
        size: String(context.limit || 10), // Algumas APIs usam 'size' em vez de 'limit'
        sort: context.sort || "relevance"
      });

      if (sourceId) params.append("sourceId", sourceId);
      if (context.storeId) params.append("storeId", context.storeId);

      const endpoint = `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`;
      
      console.log(`📡 [Lomadee] GET: ${endpoint.replace(apiKey, "***")}`); // Log seguro

      const res = await fetch(endpoint, { 
          headers: { 
              "x-api-key": apiKey, 
              "Content-Type": "application/json",
              "User-Agent": "MastraBot/1.0" // Ajuda a não ser bloqueado
          } 
      });

      // --- DIAGNÓSTICO DE RESPOSTA ---
      if (!res.ok) {
          const errText = await res.text();
          console.error(`❌ [Lomadee] Falha API: Status ${res.status} ${res.statusText}`);
          console.error(`❌ [Lomadee] Detalhe: ${errText}`);
          return { products: [] };
      }

      const data: any = await res.json();
      
      // Ajuste para diferentes formatos de resposta da Lomadee (v2/v3/beta)
      const rawProducts = data.data || data.products || data.items || [];
      
      if (rawProducts.length === 0) {
          console.log(`⚠️ [Lomadee] Busca por "${context.keyword}" retornou lista vazia. Verifique se a loja ${context.storeId || "Geral"} tem este item.`);
          return { products: [] };
      }

      const products = rawProducts.map((item: any) => {
        let finalPrice = 0;

        // Estratégia "Tente Tudo" para achar o preço
        finalPrice = parsePrice(item.price) || parsePrice(item.salePrice) || parsePrice(item.priceMin);

        // Busca profunda em options/pricing
        if (finalPrice === 0 && item.options?.length > 0) {
            const opt = item.options[0];
            finalPrice = parsePrice(opt.price) || parsePrice(opt.salePrice);
            
            if (finalPrice === 0 && opt.pricing?.length > 0) {
                finalPrice = parsePrice(opt.pricing[0].price) || parsePrice(opt.pricing[0].salePrice);
            }
        }

        // Busca profunda de imagem
        let finalImage = item.thumbnail || item.image || item.picture;
        if (!finalImage && item.options?.[0]?.images?.[0]) {
             const img = item.options[0].images[0];
             finalImage = img.url || img.large || img.medium;
        }

        return {
            id: String(item.id || item.productId || Math.random()),
            name: item.name || item.productName || context.keyword,
            price: finalPrice,
            link: item.link || item.url || item.shortUrl || "",
            image: finalImage || "",
            store: item.store?.name || item.storeName || "Lomadee"
        };
      });

      // Filtra itens quebrados antes de retornar
      const validProducts = products.filter((p: any) => p.price > 0 && p.link !== "");
      console.log(`✅ [Lomadee] Sucesso: ${validProducts.length} itens válidos recuperados.`);

      return { products: validProducts };

    } catch (e) {
      console.error("❌ [Lomadee Exception]", e);
      return { products: [] };
    }
  }
});
