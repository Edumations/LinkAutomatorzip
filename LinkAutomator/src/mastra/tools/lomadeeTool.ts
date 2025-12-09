import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos com Filtro de Relevância Estrito (Zero Tolerância)",
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
        console.error("❌ [Lomadee] ERRO: LOMADEE_API_KEY ausente.");
        return { products: [] };
    }

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

    const normalize = (str: string) => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Busca recursiva de valores (preço, nome, link)
    const findValueRecursively = (obj: any, keys: string[]): any => {
        if (!obj || typeof obj !== 'object') return null;
        for (const key of keys) {
            if (obj[key]) {
                if (keys.includes('price') || keys.includes('value')) {
                    const val = cleanPrice(obj[key]);
                    if (val > 0) return val;
                } else return obj[key];
            }
        }
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = findValueRecursively(item, keys);
                if (found) return found;
            }
            return null;
        }
        for (const k of Object.keys(obj)) {
            if (['description', 'specifications'].includes(k)) continue;
            const found = findValueRecursively(obj[k], keys);
            if (found) return found;
        }
        return null;
    };

    // --- SELETOR ESTRITO (CORRIGIDO) ---
    const findBestProductsArray = (obj: any, keyword: string): any[] => {
        let bestArray: any[] = [];
        let maxScore = 0; // Começa em 0. Se ninguém pontuar, retorna vazio.
        
        // Termos obrigatórios (remove palavras curtas como "de", "com")
        const searchTerms = normalize(keyword).split(" ").filter(w => w.length > 2);

        const scan = (node: any) => {
            if (!node) return;
            
            if (Array.isArray(node)) {
                if (node.length > 0) {
                    let currentScore = 0;
                    // Analisa amostra para performance
                    const sample = node.slice(0, 10); 
                    
                    for (const item of sample) {
                        const name = findValueRecursively(item, ['name', 'productName', 'linkName']);
                        if (name && typeof name === 'string') {
                            const normName = normalize(name);
                            // Pontua +1 para cada termo da busca encontrado no nome
                            searchTerms.forEach(term => {
                                if (normName.includes(term)) currentScore++;
                            });
                        }
                    }

                    // SÓ aceita se tiver alguma pontuação (relevância > 0)
                    // E se for melhor que o anterior
                    if (currentScore > maxScore) {
                        maxScore = currentScore;
                        bestArray = node;
                    }
                }
                return;
            }

            if (typeof node === 'object') {
                for (const key of Object.keys(node)) {
                    scan(node[key]);
                }
            }
        };

        scan(obj);
        
        if (bestArray.length === 0) {
            // console.log(`   ⚠️ Nenhum array relevante encontrado para "${keyword}"`);
        } else {
            // console.log(`   🎯 Array selecionado com score ${maxScore}`);
        }
        
        return bestArray;
    };

    try {
      const params = new URLSearchParams({
        keyword: context.keyword,
        size: String(context.limit || 12),
        sort: context.sort || "relevance"
      });

      if (sourceId) params.append("sourceId", sourceId);
      if (context.storeId && context.storeId !== "undefined") params.append("storeId", context.storeId);

      const endpoints = [
          `https://api-beta.lomadee.com.br/affiliate/products?${params.toString()}`,
          `https://api.lomadee.com/v3/${process.env.LOMADEE_APP_TOKEN || apiKey}/product/_search?${params.toString()}`
      ];

      let rawData: any = null;
      for (const url of endpoints) {
          try {
             if (url.includes("/v3/") && !process.env.LOMADEE_APP_TOKEN) continue;
             const res = await fetch(url, { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } });
             if (res.ok) { rawData = await res.json(); break; }
          } catch {}
      }

      if (!rawData) return { products: [] };

      // Agora o seletor retorna VAZIO se só tiver lixo
      const rawProducts = findBestProductsArray(rawData, context.keyword);

      if (rawProducts.length === 0) return { products: [] };

      const products = rawProducts.map((item: any) => {
        const finalPrice = findValueRecursively(item, ['price', 'salePrice', 'priceMin', 'value', 'amount', 'salesPrice']) || 0;
        const finalLink = findValueRecursively(item, ['link', 'url', 'redirectLink', 'deepLink', 'shortUrl']) || "";
        
        let finalImage = findValueRecursively(item, ['thumbnail', 'image', 'picture', 'url']); 
        if (finalImage && typeof finalImage === 'object') finalImage = finalImage.url;
        if (typeof finalImage !== 'string' || !finalImage.startsWith('http')) finalImage = "";

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

      // Filtro final de sanidade
      const validProducts = products.filter((p: any) => p.price > 0 && p.link !== "");

      return { products: validProducts };

    } catch (e) { return { products: [] }; }
  }
});
