import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const mercadolivreTool = createTool({
  id: "mercadolivre-search",
  description: "Busca produtos no Mercado Livre Brasil (MLB)",
  inputSchema: z.object({
    keyword: z.string(),
    limit: z.number().optional().default(3),
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
    try {
      const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(context.keyword)}&limit=${context.limit || 3}`;
      
      console.log(`🟡 [ML Debug] Buscando: ${url}`);
      
      // ADICIONAMOS O CABEÇALHO PARA FINGIR SER UM NAVEGADOR
      const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Accept": "application/json"
        }
      });

      if (!res.ok) {
          console.error(`❌ [ML Erro] Status: ${res.status} - ${res.statusText}`);
          return { products: [] };
      }

      const data = await res.json();
      console.log(`🟡 [ML Debug] Resultados brutos: ${data.results?.length || 0}`);

      const products = (data.results || []).map((item) => ({
        id: item.id,
        name: item.title,
        price: item.price,
        link: item.permalink,
        image: item.thumbnail ? item.thumbnail.replace("http://", "https://").replace("-I.jpg", "-V.jpg") : "",
        store: "Mercado Livre"
      }));

      return { products };
    } catch (e) {
      console.error("❌ [ML Exception]", e);
      return { products: [] };
    }
  }
});
