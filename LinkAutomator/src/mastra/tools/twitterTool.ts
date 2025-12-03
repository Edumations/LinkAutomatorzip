import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const twitterTool = createTool({
  id: "twitter-post-tweet",
  description:
    "Posts a promotional tweet to Twitter/X. Use this to share product deals and affiliate links with your Twitter audience.",

  inputSchema: z.object({
    productName: z.string().describe("Name of the product"),
    price: z.number().describe("Current price of the product"),
    originalPrice: z.number().optional().describe("Original price before discount"),
    discount: z.number().optional().describe("Discount percentage"),
    link: z.string().describe("Affiliate link to the product"),
    store: z.string().optional().describe("Store name"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    tweetId: z.string().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🐦 [TwitterTool] Starting tweet post", { 
      productName: context.productName 
    });

    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    const apiKey = process.env.TWITTER_API_KEY;
    const apiSecret = process.env.TWITTER_API_SECRET;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      logger?.warn("⚠️ [TwitterTool] Missing Twitter configuration - skipping");
      return {
        success: false,
        error: "Missing Twitter API configuration. Required: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET",
      };
    }

    try {
      const priceFormatted = new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(context.price);

      let tweetText = `🔥 OFERTA!\n\n`;
      tweetText += `${truncateText(context.productName, 80)}\n\n`;

      if (context.store) {
        tweetText += `🏪 ${context.store}\n`;
      }

      if (context.originalPrice && context.originalPrice > context.price && context.discount) {
        tweetText += `💰 ${priceFormatted} (${context.discount}% OFF)\n`;
      } else {
        tweetText += `💰 ${priceFormatted}\n`;
      }

      tweetText += `\n🛒 ${context.link}`;

      if (tweetText.length > 280) {
        tweetText = tweetText.substring(0, 277) + "...";
      }

      logger?.info("📤 [TwitterTool] Posting tweet", {
        tweetLength: tweetText.length,
      });

      const oauthParams = await generateOAuthSignature({
        method: "POST",
        url: "https://api.twitter.com/2/tweets",
        apiKey,
        apiSecret,
        accessToken,
        accessTokenSecret,
      });

      const response = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: oauthParams,
        },
        body: JSON.stringify({ text: tweetText }),
      });

      const data = await response.json();

      if (!response.ok) {
        logger?.error("❌ [TwitterTool] Twitter API error", { 
          status: response.status,
          error: data 
        });
        return {
          success: false,
          error: `Twitter API error: ${JSON.stringify(data)}`,
        };
      }

      logger?.info("✅ [TwitterTool] Tweet posted successfully", {
        tweetId: data.data?.id,
      });

      return {
        success: true,
        tweetId: data.data?.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [TwitterTool] Exception occurred", { error: errorMessage });
      
      return {
        success: false,
        error: `Failed to post tweet: ${errorMessage}`,
      };
    }
  },
});

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

async function generateOAuthSignature(params: {
  method: string;
  url: string;
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}): Promise<string> {
  const { method, url, apiKey, apiSecret, accessToken, accessTokenSecret } = params;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(oauthParams[key])}`)
    .join("&");

  const signatureBaseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramString),
  ].join("&");

  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessTokenSecret)}`;

  const signature = await hmacSha1(signingKey, signatureBaseString);
  oauthParams.oauth_signature = signature;

  const authHeader =
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((key) => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
      .join(", ");

  return authHeader;
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  const base64 = Buffer.from(new Uint8Array(signature)).toString("base64");

  return base64;
}
