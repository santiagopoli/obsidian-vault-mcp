import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { AuthHandler } from "./auth";
import { supportedScopes } from "./authPolicy";
import { createServer } from "./server";
import type { Env } from "./types";

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
    const response = await oauthProvider.fetch(request, env, context);
    if (new URL(request.url).pathname !== "/.well-known/oauth-authorization-server" || !response.ok) {
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
};
