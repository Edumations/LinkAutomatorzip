import { inngest } from "./client";
import { init, serve as originalInngestServe } from "@mastra/inngest";
import { registerApiRoute as originalRegisterApiRoute } from "@mastra/core/server";
import { type Mastra } from "@mastra/core";
// CORREÇÃO: Removemos 'NonRetriableError' dos imports para evitar erro de build
import { type Inngest, InngestFunction } from "inngest";

// Initialize Inngest with Mastra to get Inngest-compatible workflow helpers
const {
  createWorkflow: originalCreateWorkflow,
  createStep,
  cloneStep,
} = init(inngest);

export function createWorkflow(
  params: Parameters<typeof originalCreateWorkflow>[0],
): ReturnType<typeof originalCreateWorkflow> {
  return originalCreateWorkflow({
    ...params,
    retryConfig: {
      attempts: process.env.NODE_ENV === "production" ? 3 : 0,
      ...(params.retryConfig ?? {}),
    },
  });
}

// Export the Inngest client and Inngest-compatible workflow helpers
export { inngest, createStep, cloneStep };

const inngestFunctions: InngestFunction.Any[] = [];

// Create a middleware for Inngest to be able to route triggers to Mastra directly.
export function registerApiRoute<P extends string>(
  ...args: Parameters<typeof originalRegisterApiRoute<P>>
): ReturnType<typeof originalRegisterApiRoute<P>> {
  const [path, options] = args;
  if (typeof options !== "object") {
    // This will throw an error.
    return originalRegisterApiRoute(...args);
  }

  // Extract connector name from path
  const pathWithoutSlash = path.replace(/^\/+/, "");
  const pathWithoutApi = pathWithoutSlash.startsWith("api/")
    ? pathWithoutSlash.substring(4)
    : pathWithoutSlash;
  const connectorName = pathWithoutApi.split("/")[0];

  inngestFunctions.push(
    inngest.createFunction(
      {
        id: `api-${connectorName}`,
        name: path,
      },
      {
        event: `event/api.webhooks.${connectorName}.action`,
      },
      async ({ event, step }) => {
        await step.run("forward request to Mastra", async () => {
          const response = await fetch(`http://localhost:5000${path}`, {
            method: event.data.method,
            headers: event.data.headers,
            body: event.data.body,
          });

          if (!response.ok) {
            // CORREÇÃO: Usamos Error simples para simplificar o build
            throw new Error(
              `Failed to forward request to Mastra: ${response.statusText}`,
            );
          }
        });
      },
    ),
  );

  return originalRegisterApiRoute(...args);
}

// Helper function for registering cron-based workflow triggers
export function registerCronWorkflow(cronExpression: string, workflow: any) {
  console.log("🕐 [registerCronWorkflow] Registering cron trigger", {
    cronExpression,
    workflowId: workflow?.id,
  });

  const cronFunction = inngest.createFunction(
    { id: "cron-trigger" },
    [{ event: "replit/cron.trigger" }, { cron: cronExpression }],
    async ({ event, step }) => {
      return await step.run("execute-cron-workflow", async () => {
        console.log("🚀 [Cron Trigger] Starting scheduled workflow execution", {
          workflowId: workflow?.id,
          scheduledTime: new Date().toISOString(),
          cronExpression,
        });

        try {
          const run = await workflow.createRunAsync();
          console.log("📝 [Cron Trigger] Workflow run created", {
            runId: run?.id,
          });

          const result = await run.start({ inputData: {} });
          console.log("✅ [Cron Trigger] Workflow completed successfully", {
            workflowId: workflow?.id,
            status: result?.status,
          });

          return result;
        } catch (error) {
          console.error("❌ [Cron Trigger] Workflow execution failed", {
            workflowId: workflow?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          throw error;
        }
      });
    },
  );

  inngestFunctions.push(cronFunction);
  console.log(
    "✅ [registerCronWorkflow] Cron trigger registered successfully",
    {
      cronExpression,
    },
  );
}

export function inngestServe({
  mastra,
  inngest,
}: {
  mastra: Mastra;
  inngest: Inngest;
}): ReturnType<typeof originalInngestServe> {
  let serveHost: string | undefined = undefined;
  if (process.env.NODE_ENV === "production") {
    if (process.env.REPLIT_DOMAINS) {
      serveHost = `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`;
    }
  } else {
    serveHost = "http://localhost:5000";
  }
  return originalInngestServe({
    mastra,
    inngest,
    functions: inngestFunctions,
    registerOptions: { serveHost },
  });
}
