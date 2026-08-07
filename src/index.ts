import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { AuthHandler } from "./auth";
import { supportedScopes } from "./authPolicy";
import { createServer } from "./server";
import { handleGitHubWebhook } from "./webhookHandler";
import { processVaultEventMessage, reconcileVaults } from "./eventQueue";
import type { Env, VaultEventQueueMessage } from "./types";

const apiHandler = createMcpHandler(createServer);

const oauthProvider = new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [...supportedScopes],
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: unknown, context: ExecutionContext) {
      return apiHandler(request, env, context);
    },
  },
  defaultHandler: {
    fetch(request: Request, env: unknown, context: ExecutionContext) {
      return AuthHandler.fetch(request, env as Env, context);
    },
  },
});

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhooks/github") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      return handleGitHubWebhook(request, env);
    }

    const response = await oauthProvider.fetch(request, env, context);
    if (url.pathname !== "/.well-known/oauth-authorization-server" || !response.ok) {
      return response;
    }

    if (env.OMIT_AUTHORIZATION_RESPONSE_ISS !== "true") return response;
    const metadata = await response.json<Record<string, unknown>>();
    delete metadata.authorization_response_iss_parameter_supported;
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(metadata), { status: response.status, headers });
  },
  async queue(batch: MessageBatch<VaultEventQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processVaultEventMessage(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          type: "vault_event.failed",
          delivery_id: message.body.deliveryId,
          error: error instanceof Error ? error.message.slice(0, 200) : "unexpected_error",
        }));
        message.retry();
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(reconcileVaults(env));
  },
};
