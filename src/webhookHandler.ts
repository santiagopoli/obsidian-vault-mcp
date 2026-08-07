import { resolveVault } from "./config";
import { recordWebhookDelivery, markWebhookDeliveryProcessed } from "./eventStore";
import {
  defaultGitHubWebhookMaxBodyBytes,
  GitHubWebhookError,
  readGitHubWebhookHeaders,
  validateGitHubWebhook,
} from "./githubWebhook";
import { getRepositoryMetadata } from "./github";
import type { Env } from "./types";

export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  try {
    readGitHubWebhookHeaders(request.headers);
    const rawBody = await readBoundedBody(request, defaultGitHubWebhookMaxBodyBytes);
    const webhook = await validateGitHubWebhook(request.headers, rawBody, {
      secret: env.GITHUB_WEBHOOK_SECRET,
      hookId: env.GITHUB_WEBHOOK_HOOK_ID,
      repositoryId: env.GITHUB_WEBHOOK_REPOSITORY_ID,
      defaultBranchRef: `refs/heads/${env.GITHUB_WEBHOOK_DEFAULT_BRANCH}`,
    });
    const vault = resolveVault(env, env.GITHUB_WEBHOOK_VAULT);
    const repository = await getRepositoryMetadata(env.GITHUB_VAULT_TOKEN, vault);
    if (repository.id !== webhook.repositoryId || repository.defaultBranch !== env.GITHUB_WEBHOOK_DEFAULT_BRANCH) {
      throw new Error("Configured webhook repository policy does not match its vault");
    }
    const disposition = await recordWebhookDelivery(env.EVENT_DB, {
      deliveryId: webhook.deliveryId,
      hookId: webhook.hookId,
      eventType: webhook.event,
      repositoryId: webhook.repositoryId,
      vault: vault.fullName,
      ...(webhook.event === "push" ? {
        ref: webhook.ref,
        beforeSha: webhook.before,
        afterSha: webhook.after,
        forced: webhook.forced,
      } : { forced: false }),
      bodySha256: webhook.bodySha256,
    });

    if (webhook.event === "push") {
      await env.EVENTS_QUEUE.send({
        deliveryId: webhook.deliveryId,
        repositoryId: webhook.repositoryId,
        vault: vault.fullName,
        ...(webhook.before === "0".repeat(40) ? {} : { previousRevision: webhook.before }),
        ...(webhook.after === "0".repeat(40) ? {} : { afterRevision: webhook.after }),
      });
    } else if (webhook.event === "ping") {
      await markWebhookDeliveryProcessed(env.EVENT_DB, webhook.deliveryId, "ping");
    }

    return json({ ok: true, event: webhook.event, disposition }, 202);
  } catch (error) {
    if (error instanceof GitHubWebhookError) {
      return json({ ok: false, error: error.code }, error.status);
    }
    console.error(JSON.stringify({ type: "github_webhook.error", error: safeError(error) }));
    return json({ ok: false, error: "webhook_processing_failed" }, 500);
  }
}

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel("body_too_large");
      throw new GitHubWebhookError("body_too_large", "GitHub webhook body exceeds the configured limit", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unexpected_error";
}
