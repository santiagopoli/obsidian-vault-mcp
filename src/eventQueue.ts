import { parseAutomationConfig } from "./automations/config";
import { automationMatches } from "./automations/match";
import { deriveVaultEvents } from "./events";
import {
  finishAutomationRun,
  getVaultState,
  markWebhookDeliveryProcessed,
  recordWebhookDelivery,
  startAutomationRun,
  storeVaultEvents,
} from "./eventStore";
import { getMarkdownTree, getMarkdownTreeAtRevision, getRepositoryMetadata } from "./github";
import { configuredVaults, resolveVault } from "./config";
import type { VaultEvent } from "./events";
import type { AutomationDefinition } from "./automations/types";
import type { Env, VaultEventQueueMessage } from "./types";

export async function processVaultEventMessage(env: Env, message: VaultEventQueueMessage): Promise<void> {
  const vault = resolveVault(env, message.vault);
  if (message.previousRevision && message.afterRevision) {
    const [previous, current] = await Promise.all([
      getMarkdownTreeAtRevision(env.GITHUB_VAULT_TOKEN, vault, message.previousRevision),
      getMarkdownTreeAtRevision(env.GITHUB_VAULT_TOKEN, vault, message.afterRevision),
    ]);
    const events = deriveVaultEvents(message.repositoryId, previous, current);
    await runMatchingAutomations(env, vault.fullName, message.repositoryId, events);
    const head = await getMarkdownTree(env.GITHUB_VAULT_TOKEN, vault);
    await storeVaultEvents(env.EVENT_DB, message.repositoryId, vault.fullName, head.revision, events);
    await markWebhookDeliveryProcessed(env.EVENT_DB, message.deliveryId);
    return;
  }

  const current = await getMarkdownTree(env.GITHUB_VAULT_TOKEN, vault);
  const state = await getVaultState(env.EVENT_DB, message.repositoryId);
  if (state?.revision === current.revision) {
    await markWebhookDeliveryProcessed(env.EVENT_DB, message.deliveryId, "superseded");
    return;
  }

  const previousRevision = state?.revision ?? message.previousRevision;
  if (!previousRevision) {
    await storeVaultEvents(env.EVENT_DB, message.repositoryId, vault.fullName, current.revision, []);
    await markWebhookDeliveryProcessed(env.EVENT_DB, message.deliveryId, "baseline");
    return;
  }
  const previous = await getMarkdownTreeAtRevision(env.GITHUB_VAULT_TOKEN, vault, previousRevision);
  const events = deriveVaultEvents(message.repositoryId, previous, current);
  await runMatchingAutomations(env, vault.fullName, message.repositoryId, events);
  await storeVaultEvents(env.EVENT_DB, message.repositoryId, vault.fullName, current.revision, events);
  await markWebhookDeliveryProcessed(env.EVENT_DB, message.deliveryId);
}

export async function reconcileVaults(env: Env): Promise<void> {
  for (const vault of configuredVaults(env)) {
    const [repository, current] = await Promise.all([
      getRepositoryMetadata(env.GITHUB_VAULT_TOKEN, vault),
      getMarkdownTree(env.GITHUB_VAULT_TOKEN, vault),
    ]);
    const state = await getVaultState(env.EVENT_DB, repository.id);
    if (state?.revision === current.revision) continue;

    const deliveryId = reconciliationDeliveryId(repository.id, current.revision);
    await recordWebhookDelivery(env.EVENT_DB, {
      deliveryId,
      hookId: env.GITHUB_WEBHOOK_HOOK_ID,
      eventType: "reconcile",
      repositoryId: repository.id,
      vault: vault.fullName,
      afterSha: current.revision,
      forced: false,
      bodySha256: current.revision.padEnd(64, "0").slice(0, 64),
    });
    await env.EVENTS_QUEUE.send({ deliveryId, repositoryId: repository.id, vault: vault.fullName });
  }
}

async function runMatchingAutomations(
  env: Env,
  vault: string,
  repositoryId: string,
  events: VaultEvent[],
): Promise<void> {
  const config = parseAutomationConfig(env.AUTOMATIONS_YAML ?? "version: 1\nautomations: []\n");
  for (const event of events) {
    for (const automation of config.automations) {
      if (!automationMatches(automation, vault, event)) continue;
      await runAutomation(env, automation, repositoryId, vault, event);
    }
  }
}

async function runAutomation(
  env: Env,
  automation: AutomationDefinition,
  repositoryId: string,
  vault: string,
  event: VaultEvent,
): Promise<void> {
  const handler = automation.target.handler;
  const run = await startAutomationRun(env.EVENT_DB, automation.id, event, repositoryId, vault, handler);
  if (run.status === "succeeded") return;
  if (run.status === "running") throw new Error(`automation_in_progress:${automation.id}`);
  try {
    await dispatchInternalHandler(handler, event);
    await finishAutomationRun(env.EVENT_DB, run.runId, "succeeded");
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 200) : "unexpected_error";
    await finishAutomationRun(env.EVENT_DB, run.runId, "failed", errorCode);
    throw error;
  }
}

async function dispatchInternalHandler(handler: string, event: VaultEvent): Promise<void> {
  if (handler === "log-event") {
    console.log(JSON.stringify({ type: "automation.delivered", handler, event_id: event.id, event_type: event.type }));
    return;
  }
  throw new Error(`unknown_internal_handler:${handler}`);
}

function reconciliationDeliveryId(repositoryId: string, revision: string): string {
  return `reconcile:v1:${repositoryId}:${revision}`;
}
