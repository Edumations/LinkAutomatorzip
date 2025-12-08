import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos na Lomadee com Varredura Recursiva de Preços (Raio-X)",
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

    // --- HELPER: Limpeza de Preço ---
    const cleanPrice = (val: any): number => {
        if (typeof val === 'number') return val;
        if (!val) return 0;
        try {
            let str = String(val).trim();
            str = str.replace(/[^\d.,]/g, ""); 
            if (str.includes(",") && str.includes(".")) str = str.replace(/\./g, "").replace(",", ".");
            else if (str.includes(",")) str = str.replace(",", ".");
            return parseFloat(str) || 0;
        } catch { return 0; }
    };

    // --- "RAIO-X": BUSCA RECURSIVA DE CHAVES ---
    // Encontra o primeiro valor numérico associado a chaves de preço em qualquer profundidade
    const findValueRecursively = (obj: any, keys: string[]): any => {
        if (!obj || typeof obj !== 'object') return null;

        // 1. Verifica se o objeto atual tem a chave
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "" && obj[key] !== 0) {
                // Se for preço, valida se é número válido
                if (keys.includes('price') || keys.includes('value')) {
                    const val = cleanPrice(obj[key]);
                    if (val > 0) return val;
                } else {
                    return obj[key]; // Para links/imagens/nomes
                }
            }
        }

        // 2. Se for array, mergulha nos itens
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = findValueRecursively(item, keys);
                if (found) return found;
            }
            return null;
        }

        // 3. Se for objeto, mergulha nos valores
        for (const k of Object.keys(obj)) {
            // Evita loops em chaves gigantes ou irrelevantes
            if (['description', 'specifications', 'content'].includes(k)) continue;
            
            const found = findValueRecursively(obj[k], keys);
            if (found) return found;
        }

        return null;
    };

    // Encontra o array principal de produtos no JSON
    const findProductsArray = (obj: any): any[] => {
        if (!obj) return [];
        if (Array.isArray(obj)) {
            // Heurística: É um array de produtos se tiver ID, Nome ou Preço
            if (obj.length > 0) {
                const item = obj[0];
                if (item && (item.id || item._id || item.name || item.productName)) return obj;
            }
            return [];
        }
        if (typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
                const res = findProductsArray(obj[key]);
                if (res.length > 0) return res;
            }
        }
        return [];
    };

    try {
      const params = new URLSearchParams({
        keyword: context.keyword,
        size: String(context.limit || 12),
        sort: context.sort || "relevance"
      });

      if (sourceId) params.append("sourceId", sourceId);
      if (context.storeId && context.storeId !== "undefined") params.append("storeId", context.storeId);

      console.log(`📡 [Lomadee] Buscando "${context.keyword}"...`);

      // Tenta endpoint Beta e V3 (Fallback automático)
      const endpoints = [
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          `https://api.lomadee.com/v3/${process.env.LOMADEE_APP_TOKEN || apiKey}/product/_search?${params.toString()}`
      ];

      let rawData: any = null;
      for (const url of endpoints) {
          try {
             if (url.includes("/v3/") && !process.env.LOMADEE_APP_TOKEN) continue;
             const res = await fetch(url, { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } });
             if (res.ok) {
                 rawData = await res.json();
                 break;
             }
          } catch {}
      }

      if (!rawData) {
          console.log(`⚠️ [Lomadee] Falha na conexão ou lista vazia.`);
          return { products: [] };
      }

      const rawProducts = findProductsArray(rawData);

      if (rawProducts.length === 0) {
          console.log(`⚠️ [Lomadee] JSON recebido, mas nenhum array de produtos encontrado.`);
          return { products: [] };
      }

      const products = rawProducts.map((item: any) => {
        // --- USANDO O RAIO-X ---
        // Procura preço em TUDO (offers, skus, variants, root)
        const finalPrice = findValueRecursively(item, ['price', 'salePrice', 'priceMin', 'value', 'amount', 'salesPrice']) || 0;
        
        // Procura link em TUDO
        const finalLink = findValueRecursively(item, ['link', 'url', 'redirectLink', 'deepLink', 'shortUrl']) || "";
        
        // Procura imagem em TUDO
        let finalImage = findValueRecursively(item, ['thumbnail', 'image', 'picture', 'url']); 
        // Filtra URL válida de imagem
        if (finalImage && typeof finalImage === 'object') finalImage = finalImage.url;
        if (typeof finalImage !== 'string' || !finalImage.startsWith('http')) finalImage = "";

        // Tenta achar nome ou usa a keyword
        const finalName = findValueRecursively(item, ['name', 'productName', 'linkName']) || context.keyword;
        
        const storeName = item.store?.name || item.storeName || item.seller?.name || "Oferta";
        const uniqueId = `${item.id || item._id || Math.random().toString(36)}-${storeName.replace(/\s+/g, '')}`;

        return {
            id: uniqueId,
            name: finalName,
            price: finalPrice,
            link: finalLink,
            image: finalImage,
            store: storeName
        };
      });

      // Filtro Final
      const validProducts = products.filter((p: any) => p.price > 0 && p.link !== "");

      if (rawProducts.length > 0 && validProducts.length === 0) {
          console.log(`🚨 [DEBUG] ${rawProducts.length} itens encontrados, mas o Raio-X não achou preço/link.`);
          // Dump das chaves para você saber onde procurar se falhar de novo
          console.log(`   Chaves do item: ${Object.keys(rawProducts[0]).join(", ")}`);
      } else if (validProducts.length > 0) {
          console.log(`✅ [Lomadee] Sucesso! ${validProducts.length} itens prontos.`);
      }

      return { products: validProducts };

    } catch (e) {
      console.error("❌ [Lomadee Exception]", e);
      return { products: [] };
    }
  }
});
