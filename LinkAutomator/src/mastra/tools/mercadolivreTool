import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const mercadolivreTool = createTool({
  id: "mercadolivre-search",
  description: "Busca produtos no Mercado Livre Brasil (MLB)",
  inputSchema: z.object({
    keyword: z.string().describe("O que você quer buscar (ex: Iphone, Geladeira)"),
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
      // Busca na API Pública do Mercado Livre
      const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(context.keyword)}&limit=${context.limit || 3}`;
      
      const res = await fetch(url);
      const data = await res.json();
      
      // AQUI ESTAVA O ERRO: Removi o ": any" para evitar conflito de sintaxe
      const products = (data.results || []).map((item) => ({
        id: item.id,
        name: item.title,
        price: item.price,
        link: item.permalink, // Link original do produto
        // Melhora a qualidade da imagem trocando I (Thumb) por V (Maior) se possível, ou mantém original
        image: item.thumbnail ? item.thumbnail.replace("http://", "https://").replace("-I.jpg", "-V.jpg") : "",
        store: "Mercado Livre"
      }));

      return { products };
    } catch (e) {
      console.error("Erro na busca do Mercado Livre:", e);
      return { products: [] };
    }
  }
});
