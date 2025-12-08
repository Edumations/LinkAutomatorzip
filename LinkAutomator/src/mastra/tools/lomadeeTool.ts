import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee com Varredura Profunda de JSON",
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
        console.error("❌ [Lomadee] ERRO: Variável LOMADEE_API_KEY ausente.");
        return { products: [] };
    }

    // --- FUNÇÃO DE VARREDURA PROFUNDA (O Segredo da Resiliência) ---
    // Procura recursivamente por qualquer array que pareça conter produtos
    const findProductsInJson = (obj: any): any[] => {
        if (!obj) return [];
        
        // Se achou um array, verifica se os itens parecem produtos
        if (Array.isArray(obj)) {
            if (obj.length > 0) {
                const item = obj[0];
                // Critério: Tem nome ou preço ou link? Então é produto!
                if (item && (item.name || item.productName || item.link || item.url || item.price)) {
                    return obj;
                }
            }
            return [];
        }
        
        // Se é objeto, mergulha nas chaves (data, products, items, offers, etc)
        if (typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
                const found = findProductsInJson(obj[key]);
                if (found.length > 0) return found;
            }
        }
        return [];
    };

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
      if (context.storeId && context.storeId !== "undefined") {
          params.append("storeId", context.storeId);
      }

      // Tenta endpoint v3 padrão se o beta falhar
      // Dica: Muitos usuários acham que usam beta mas a chave é v2/v3
      const endpoints = [
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          `https://api.lomadee.com/v3/${process.env.LOMADEE_APP_TOKEN || apiKey}/product/_search?${params.toString()}` // Fallback
      ];

      let rawData: any = null;
      let successEndpoint = "";

      // Tenta endpoints até um funcionar
      for (const url of endpoints) {
          try {
              // Só tenta o segundo se tiver app_token ou usar a key como token
              if (url.includes("/v3/") && !process.env.LOMADEE_APP_TOKEN) continue;

              const res = await fetch(url, { 
                  headers: { "x-api-key": apiKey, "Content-Type": "application/json" } 
              });
              
              if (res.ok) {
                  rawData = await res.json();
                  successEndpoint = url;
                  break; 
              }
          } catch (e) {}
      }

      if (!rawData) {
          console.log(`⚠️ [Lomadee] Falha em todos os endpoints para loja ${context.storeId || "Geral"}`);
          return { products: [] };
      }

      // USA A VARREDURA PROFUNDA
      const rawProducts = findProductsInJson(rawData);

      if (rawProducts.length === 0) {
          // Log de diagnóstico para você ver o que a API devolveu
          console.log(`⚠️ [Lomadee] JSON recebido mas nenhum produto encontrado. Chaves raiz: ${Object.keys(rawData).join(", ")}`);
          return { products: [] };
      }

      const products = rawProducts.map((item: any) => {
        let finalPrice = parsePrice(item.price) || parsePrice(item.salePrice) || parsePrice(item.priceMin) || parsePrice(item.priceMax);
        
        // Tenta achar preço dentro de estruturas aninhadas (comum na Lomadee)
        if (finalPrice === 0) {
            const nested = findProductsInJson(item); // Reutiliza a varredura dentro do item
            if (nested.length > 0) { 
               // Tenta pegar preço de sku/offer dentro do produto
               // Lógica simplificada: pega o primeiro número que achar
            }
            // Fallback manual para options/offers
            if (item.options?.[0]) finalPrice = parsePrice(item.options[0].price);
            else if (item.offers?.[0]) finalPrice = parsePrice(item.offers[0].price);
        }

        let finalImage = item.thumbnail || item.image || item.picture || item.linkImage;
        if (!finalImage) {
            if (item.options?.[0]?.images?.[0]) finalImage = item.options[0].images[0];
            else if (item.offers?.[0]?.image) finalImage = item.offers[0].image;
        }
        if (typeof finalImage === 'object') finalImage = finalImage.url || finalImage.link; // Se imagem for objeto

        const storeName = item.store?.name || item.storeName || item.seller?.name || "Oferta";
        const uniqueId = `${item.id || item.productId}-${storeName.replace(/\s+/g, '')}`;

        return {
            id: uniqueId,
            name: item.name || item.productName || item.linkName || context.keyword,
            price: finalPrice,
            link: item.link || item.url || item.redirectLink || "",
            image: finalImage || "",
            store: storeName
        };
      });

      return { products: products.filter((p: any) => p.price > 0 && p.link) };

    } catch (e) {
      console.error("❌ [Lomadee Critical]", e);
      return { products: [] };
    }
  }
});
