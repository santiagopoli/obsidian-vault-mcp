import { enqueueAutomationJob, listPendingAutomationJobs, markAutomationJobDispatched } from "./automationStore";
import { automationConfigHash } from "./automations/configHash";
import { parseAutomationConfig } from "./automations/config";
import { automationMatches } from "./automations/match";
import { summaryOutputPath } from "./automations/summarizeNote";
import { configuredVaults, resolveVault } from "./config";
import { deriveVaultEvents, type VaultEvent } from "./events";
import {
  getVaultState,
  markWebhookDeliveryProcessed,
  recordWebhookDelivery,
  storeVaultEvents,
} from "./eventStore";
import { getMarkdownTree, getMarkdownTreeAtRevision, getRepositoryMetadata } from "./github";
import type { AutomationDefinition } from "./automations/types";
import type { Env, VaultEventQueueMessage } from "./types";

export async function processVaultEventMessage(env: Env, message: VaultEventQueueMessage): Promise<void> {
  const vault = resolveVault(env, message.vault);
  const current = await getMarkdownTree(env.GITHUB_VAULT_TOKEN, vault);
  const state = await getVaultState(env.EVENT_DB, message.repositoryId);
  if (state?.revision === current.revision) {
    await markWebhookDeliveryProcessed(env.EVENT_DB, message.deliveryId, "superseded");
    await dispatchPendingAutomationJobs(env);
    return;
  }

  const previousRevision = state?.revision ?? message.previousRevision;
  if (!previousRevision) {
    await storeVaultEvents(env.EVENT_DB, message.repositoryId, vault.fullName, current.revision, []);
    await markWebhookDeliveryProcessed(env.EVENT_DB, message.deliveryId, "baseline");
    await dispatchPendingAutomationJobs(env);
    return;
  }
  const previous = await getMarkdownTreeAtRevision(env.GITHUB_VAULT_TOKEN, vault, previousRevision);
  const events = deriveVaultEvents(message.repositoryId, previous, current);
  await enqueueMatchingAutomations(env, vault.fullName, message.repositoryId, events);
  await storeVaultEvents(env.EVENT_DB, message.repositoryId, vault.fullName, current.revision, events);
  await markWebhookDeliveryProcessed(env.EVENT_DB, message.deliveryId);
  await dispatchPendingAutomationJobs(env);
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
    await env.EVENTS_QUEUE.send({ kind: "vault-event", deliveryId, repositoryId: repository.id, vault: vault.fullName });
  }
}

export async function dispatchPendingAutomationJobs(env: Env): Promise<void> {
  const pending = await listPendingAutomationJobs(env.EVENT_DB);
  for (const job of pending) {
    await env.AUTOMATIONS_QUEUE.send({ kind: "automation", runId: job.runId });
    await markAutomationJobDispatched(env.EVENT_DB, job.runId);
  }
}

async function enqueueMatchingAutomations(
  env: Env,
  vault: string,
  repositoryId: string,
  events: VaultEvent[],
): Promise<void> {
  const config = parseAutomationConfig(env.AUTOMATIONS_YAML ?? "version: 1\nautomations: []\n");
  for (const event of events) {
    for (const automation of config.automations) {
      if (!automationMatches(automation, vault, event)) continue;
      await enqueueAutomation(env, automation, repositoryId, vault, event);
    }
  }
}

async function enqueueAutomation(
  env: Env,
  automation: AutomationDefinition,
  repositoryId: string,
  vault: string,
  event: VaultEvent,
): Promise<void> {
  const sourceSha = event.type === "note.created"
    ? event.noteSha
    : event.type === "note.updated"
      ? event.afterSha
      : event.noteSha;
  const outputPath = automation.target.handler === "summarize-note"
    ? summaryOutputPath(automation.target.output.directory, event.path)
    : event.path;
  await enqueueAutomationJob(env.EVENT_DB, {
    automationId: automation.id,
    handler: automation.target.handler,
    configHash: await automationConfigHash(automation),
    eventId: event.id,
    repositoryId,
    vault,
    sourcePath: event.path,
    sourceRevision: event.afterRevision,
    sourceSha,
    outputPath,
  });
}

function reconciliationDeliveryId(repositoryId: string, revision: string): string {
  return `reconcile:v1:${repositoryId}:${revision}`;
}
