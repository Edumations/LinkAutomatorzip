import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const checkPostedProductsTool = createTool({
  id: "check-posted-products",
  description:
    "Checks which products have already been posted to social media to avoid duplicates. Returns list of product IDs that are new (not yet posted).",

  inputSchema: z.object({
    productIds: z.array(z.string()).describe("List of Lomadee product IDs to check"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    newProductIds: z.array(z.string()),
    alreadyPostedIds: z.array(z.string()),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [CheckPostedProducts] Checking product IDs", {
      count: context.productIds.length,
    });

    if (context.productIds.length === 0) {
      return {
        success: true,
        newProductIds: [],
        alreadyPostedIds: [],
      };
    }

    try {
      const placeholders = context.productIds
        .map((_, i) => `$${i + 1}`)
        .join(", ");
      
      const result = await pool.query(
        `SELECT lomadee_product_id FROM posted_products WHERE lomadee_product_id IN (${placeholders})`,
        context.productIds
      );

      const postedIds = new Set(
        result.rows.map((row: { lomadee_product_id: string }) => row.lomadee_product_id)
      );
      
      const newProductIds = context.productIds.filter((id) => !postedIds.has(id));
      const alreadyPostedIds = context.productIds.filter((id) => postedIds.has(id));

      logger?.info("✅ [CheckPostedProducts] Check complete", {
        newCount: newProductIds.length,
        alreadyPostedCount: alreadyPostedIds.length,
      });

      return {
        success: true,
        newProductIds,
        alreadyPostedIds,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [CheckPostedProducts] Exception occurred", { error: errorMessage });

      return {
        success: false,
        newProductIds: [],
        alreadyPostedIds: [],
        error: `Failed to check products: ${errorMessage}`,
      };
    }
  },
});

export const markProductAsPostedTool = createTool({
  id: "mark-product-posted",
  description:
    "Marks a product as posted to specific social media platforms to prevent duplicate posts.",

  inputSchema: z.object({
    productId: z.string().describe("Lomadee product ID"),
    productName: z.string().describe("Product name"),
    productLink: z.string().describe("Product affiliate link"),
    productPrice: z.number().describe("Product price"),
    postedTelegram: z.boolean().optional().default(false).describe("Posted to Telegram"),
    postedWhatsapp: z.boolean().optional().default(false).describe("Posted to WhatsApp"),
    postedTwitter: z.boolean().optional().default(false).describe("Posted to Twitter/X"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [MarkProductPosted] Marking product as posted", {
      productId: context.productId,
      telegram: context.postedTelegram,
      whatsapp: context.postedWhatsapp,
      twitter: context.postedTwitter,
    });

    try {
      await pool.query(
        `INSERT INTO posted_products 
         (lomadee_product_id, product_name, product_link, product_price, posted_telegram, posted_whatsapp, posted_twitter, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (lomadee_product_id) 
         DO UPDATE SET 
           posted_telegram = posted_products.posted_telegram OR EXCLUDED.posted_telegram,
           posted_whatsapp = posted_products.posted_whatsapp OR EXCLUDED.posted_whatsapp,
           posted_twitter = posted_products.posted_twitter OR EXCLUDED.posted_twitter,
           posted_at = NOW()`,
        [
          context.productId,
          context.productName,
          context.productLink,
          context.productPrice,
          context.postedTelegram || false,
          context.postedWhatsapp || false,
          context.postedTwitter || false,
        ]
      );

      logger?.info("✅ [MarkProductPosted] Product marked successfully", {
        productId: context.productId,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [MarkProductPosted] Exception occurred", { error: errorMessage });

      return {
        success: false,
        error: `Failed to mark product as posted: ${errorMessage}`,
      };
    }
  },
});

export const getRecentlyPostedProductsTool = createTool({
  id: "get-recently-posted-products",
  description:
    "Gets list of recently posted products with their details and posting status.",

  inputSchema: z.object({
    limit: z.number().optional().default(50).describe("Maximum number of products to return"),
    hoursAgo: z.number().optional().default(24).describe("Get products posted within this many hours"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(
      z.object({
        productId: z.string(),
        productName: z.string(),
        productLink: z.string(),
        productPrice: z.number(),
        postedTelegram: z.boolean(),
        postedWhatsapp: z.boolean(),
        postedTwitter: z.boolean(),
        postedAt: z.string(),
      })
    ),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [GetRecentlyPosted] Fetching recently posted products", {
      limit: context.limit,
      hoursAgo: context.hoursAgo,
    });

    try {
      const result = await pool.query(
        `SELECT 
           lomadee_product_id as "productId",
           product_name as "productName",
           product_link as "productLink",
           product_price as "productPrice",
           posted_telegram as "postedTelegram",
           posted_whatsapp as "postedWhatsapp",
           posted_twitter as "postedTwitter",
           posted_at as "postedAt"
         FROM posted_products 
         WHERE posted_at > NOW() - INTERVAL '${context.hoursAgo || 24} hours'
         ORDER BY posted_at DESC
         LIMIT $1`,
        [context.limit || 50]
      );

      const products = result.rows.map((row: any) => ({
        ...row,
        productPrice: parseFloat(row.productPrice) || 0,
        postedAt: row.postedAt?.toISOString() || new Date().toISOString(),
      }));

      logger?.info("✅ [GetRecentlyPosted] Products fetched", {
        count: products.length,
      });

      return {
        success: true,
        products,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [GetRecentlyPosted] Exception occurred", { error: errorMessage });

      return {
        success: false,
        products: [],
        error: `Failed to get recently posted products: ${errorMessage}`,
      };
    }
  },
});
