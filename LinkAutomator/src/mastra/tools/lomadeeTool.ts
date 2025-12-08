import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee com conversor de preços robusto",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(12),
    sort: z.string().optional().default("relevance"),
    storeId: z.string().nullish(),
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
        console.error("❌ [Lomadee] ERRO CRÍTICO: Variável LOMADEE_API_KEY não definida.");
        return { products: [] };
    }

    // --- FUNÇÃO DE VARREDURA (Mantida) ---
    const findProductsInJson = (obj: any): any[] => {
        if (!obj) return [];
        if (Array.isArray(obj)) {
            if (obj.length > 0) {
                const item = obj[0];
                if (item && (item.name || item.productName || item.link || item.url || item.price)) return obj;
            }
            return [];
        }
        if (typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
                const found = findProductsInJson(obj[key]);
                if (found.length > 0) return found;
            }
        }
        return [];
    };

    // --- CONVERSOR DE PREÇO BLINDADO ---
    const parsePrice = (value: any): number => {
        if (!value) return 0;
        
        // Se for número direto
        if (typeof value === 'number') return value;
        
        // Se for objeto (comum em APIs: { value: 10, currency: "BRL" })
        if (typeof value === 'object') {
            return parsePrice(value.value || value.price || value.min || value.max || value.salesPrice || 0);
        }

        try {
            let str = String(value).trim();
            // Remove caracteres inválidos, mantendo dígitos, ponto e vírgula
            str = str.replace(/[^\d.,]/g, ""); 
            
            if (str === "") return 0;

            // Lógica para BRL (1.000,00) vs USD (1,000.00)
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
        size: String(context.limit || 12),
        sort: context.sort || "relevance"
      });

      if (sourceId) params.append("sourceId", sourceId);
      if (context.storeId && context.storeId !== "undefined") {
          params.append("storeId", context.storeId);
      }

      // Endpoint principal
      const url = `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`;
      
      // LOG DE DIAGNÓSTICO (Para sabermos que tentou)
      console.log(`📡 [Lomadee] Buscando "${context.keyword}"...`);

      const res = await fetch(url, { 
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" } 
      });
      
      if (!res.ok) {
          // Log de erro HTTP
          console.log(`⚠️ [Lomadee] Erro HTTP ${res.status} ao buscar "${context.keyword}"`);
          return { products: [] };
      }

      const rawData = await res.json();
      const rawProducts = findProductsInJson(rawData);

      if (rawProducts.length === 0) {
          console.log(`⚠️ [Lomadee] Busca vazia para "${context.keyword}". JSON recebido OK.`);
          return { products: [] };
      }

      const products = rawProducts.map((item: any) => {
        let finalPrice = 0;
        // Tenta extrair preço de vários lugares
        finalPrice = parsePrice(item.price) || parsePrice(item.salePrice) || parsePrice(item.priceMin);
        
        // Se falhou, tenta descer no objeto
        if (finalPrice === 0 && item.offers && item.offers.length > 0) {
            finalPrice = parsePrice(item.offers[0].price);
        }

        let finalImage = item.thumbnail || item.image || item.picture;
        if (!finalImage && item.thumbnail?.url) finalImage = item.thumbnail.url; // Caso a imagem seja objeto

        const storeName = item.store?.name || item.storeName || "Oferta";
        const uniqueId = `${item.id || item.productId}-${storeName.replace(/\s+/g, '')}`;

        return {
            id: uniqueId,
            name: item.name || item.productName || context.keyword,
            price: finalPrice,
            link: item.link || item.url || "",
            image: typeof finalImage === 'string' ? finalImage : "",
            store: storeName
        };
      });

      // Filtra e LOGA se perder muitos itens
      const validProducts = products.filter((p: any) => p.price > 0 && p.link);
      
      if (products.length > 0 && validProducts.length === 0) {
          console.log(`🚨 [DEBUG] ${products.length} itens encontrados, mas TODOS tinham preço 0 ou link quebrado.`);
          // Imprime o primeiro item cru para debugarmos se necessário
          console.log(`   Exemplo de item cru: ${JSON.stringify(rawProducts[0]).slice(0, 200)}`);
      } else if (validProducts.length > 0) {
          console.log(`✅ [Lomadee] Sucesso: ${validProducts.length} itens válidos.`);
      }

      return { products: validProducts };

    } catch (e) {
      console.error("❌ [Lomadee Exception]", e);
      return { products: [] };
    }
  }
});
