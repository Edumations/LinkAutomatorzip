import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const lomadeeTool = createTool({
  id: "lomadee-fetch-products",
  description: "Busca produtos com Score de Relevância e Varredura Profunda",
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
        console.error("❌ [Lomadee] ERRO: API KEY não definida.");
        return { products: [] };
    }

    // --- 1. LIMPEZA E UTILITÁRIOS ---
    const cleanPrice = (val: any): number => {
        if (typeof val === 'number') return val;
        if (!val) return 0;
        try {
            let str = String(val).trim().replace(/[^\d.,]/g, ""); 
            if (str.includes(",") && str.includes(".")) str = str.replace(/\./g, "").replace(",", ".");
            else if (str.includes(",")) str = str.replace(",", ".");
            return parseFloat(str) || 0;
        } catch { return 0; }
    };

    const normalize = (str: string) => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // --- 2. BUSCA PROFUNDA DE VALORES ---
    const findValue = (obj: any, keys: string[]): any => {
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
                const found = findValue(item, keys);
                if (found) return found;
            }
            return null;
        }
        for (const k of Object.keys(obj)) {
            if (['description', 'specifications'].includes(k)) continue; // Otimização
            const found = findValue(obj[k], keys);
            if (found) return found;
        }
        return null;
    };

    // --- 3. SELETOR INTELIGENTE (O "Detector de Mentiras") ---
    // Analisa todos os arrays do JSON e escolhe o que tem mais a ver com a busca
    const findBestArray = (obj: any, keyword: string): any[] => {
        let bestArray: any[] = [];
        let maxScore = 0;
        // Termos obrigatórios (ignora palavras curtas)
        const terms = normalize(keyword).split(" ").filter(w => w.length > 2);

        const scan = (node: any) => {
            if (!node) return;
            if (Array.isArray(node) && node.length > 0) {
                let score = 0;
                const sample = node.slice(0, 5); // Amostra para performance
                
                for (const item of sample) {
                    const name = findValue(item, ['name', 'productName', 'linkName']);
                    if (name && typeof name === 'string') {
                        const normName = normalize(name);
                        // Pontua se o nome do produto contém termos da busca
                        const matches = terms.filter(t => normName.includes(t)).length;
                        score += matches;
                    }
                }

                // Só aceita se tiver pontuação relevante (evita "Mais Vendidos" aleatórios)
                if (score > maxScore) {
                    maxScore = score;
                    bestArray = node;
                }
                return;
            }
            if (typeof node === 'object') {
                for (const key of Object.keys(node)) scan(node[key]);
            }
        };

        scan(obj);
        
        // Se o score for zero, significa que a lista não tem nada a ver com a busca.
        if (maxScore === 0 && bestArray.length > 0) {
            // console.log(`   ⚠️ [Lomadee] Lista ignorada por irrelevância (Score 0)`);
            return [];
        }
        return bestArray;
    };

    try {
      const params = new URLSearchParams({
        keyword: context.keyword,
        size: String(context.limit || 12),
        sort: "relevance"
      });

      if (sourceId) params.append("sourceId", sourceId);
      if (context.storeId) params.append("storeId", context.storeId);

      // Tenta endpoints Beta e V3 automaticamente
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

      // Aplica o Seletor Inteligente
      const rawProducts = findBestArray(rawData, context.keyword);

      if (rawProducts.length === 0) return { products: [] };

      const products = rawProducts.map((item: any) => {
        // Varre o item em busca das propriedades, não importa onde estejam
        const price = findValue(item, ['price', 'salePrice', 'priceMin', 'value', 'amount']) || 0;
        const link = findValue(item, ['link', 'url', 'redirectLink', 'deepLink']) || "";
        let image = findValue(item, ['thumbnail', 'image', 'picture', 'url']);
        if (image && typeof image === 'object') image = image.url;
        
        const name = findValue(item, ['name', 'productName', 'linkName']) || context.keyword;
        const store = item.store?.name || item.storeName || "Oferta";
        const id = `${item.id || item._id || Math.random().toString(36)}-${store.replace(/\s+/g, '')}`;

        return { id, name, price, link, image: typeof image === 'string' ? image : "", store };
      });

      // Filtro final: Preço > 0 e Link válido
      return { products: products.filter(p => p.price > 0 && p.link) };

    } catch (e) { return { products: [] }; }
  }
});
