import {
  assertAutomationJobCanWrite,
  AutomationJobWriteFenceError,
  claimAutomationJob,
  finishAutomationJob,
  markAutomationJobDispatched,
  type AutomationJobRecord,
} from "./automationStore";
import { automationConfigHash } from "./automations/configHash";
import { parseAutomationConfig } from "./automations/config";
import { AutomationProviderError, summarizeWithOpenAI } from "./automations/openaiSummarizer";
import { summarizeNote } from "./automations/summarizeNote";
import { resolveVault } from "./config";
import { GitHubError, readMarkdownBlobAtSha, readMarkdownFile, writeMarkdownFile } from "./github";
import type { SummarizeNoteAutomationTarget } from "./automations/types";
import type { AutomationJobQueueMessage, Env } from "./types";

const leaseDurationMs = 5 * 60_000;
const maxAttempts = 6;

export async function processAutomationJobMessage(env: Env, message: AutomationJobQueueMessage): Promise<void> {
  const leaseToken = crypto.randomUUID();
  const job = await claimAutomationJob(env.EVENT_DB, message.runId, { leaseToken, leaseDurationMs });
  if (!job) return;

  try {
    await executeAutomation(env, job, leaseToken);
  } catch (error) {
    if (error instanceof AutomationJobWriteFenceError) {
      await finish(env, job, leaseToken, "skipped_superseded", "write_fence_lost");
      return;
    }
    if (isConflict(error)) {
      await finish(env, job, leaseToken, "conflict", "managed_output_conflict");
      return;
    }
    if (isRetryable(error)) {
      if (job.attempts >= maxAttempts) {
        await finish(env, job, leaseToken, "failed_terminal", `retry_exhausted:${errorCode(error)}`);
        return;
      }
      await scheduleRetry(env, job, leaseToken, errorCode(error));
      return;
    }
    await finish(env, job, leaseToken, "failed_terminal", errorCode(error));
    return;
  }
  await finish(env, job, leaseToken, "succeeded");
}

async function executeAutomation(env: Env, job: AutomationJobRecord, leaseToken: string): Promise<void> {
  const automation = parseAutomationConfig(env.AUTOMATIONS_YAML ?? "version: 1\nautomations: []\n")
    .automations.find((candidate) => candidate.id === job.automationId && candidate.enabled);
  if (!automation || await automationConfigHash(automation) !== job.configHash || automation.target.handler !== job.handler) {
    throw new Error("automation_config_changed");
  }
  if (automation.target.handler === "log-event") {
    console.log(JSON.stringify({
      type: "automation.delivered",
      handler: automation.target.handler,
      automation_id: automation.id,
      event_id: job.eventId,
    }));
    return;
  }
  await runSummary(env, job, leaseToken, automation.target);
}

async function runSummary(
  env: Env,
  job: AutomationJobRecord,
  leaseToken: string,
  target: SummarizeNoteAutomationTarget,
): Promise<void> {
  const vault = resolveVault(env, job.vault);
  const source = await readMarkdownBlobAtSha(env.GITHUB_VAULT_TOKEN, vault, job.sourcePath, job.sourceSha);
  await summarizeNote({
    automationId: job.automationId,
    eventId: job.eventId,
    source,
    target,
    model: async ({ content, model, maxCharacters }) => {
      const result = await summarizeWithOpenAI({
        apiKey: env.OPENAI_API_KEY ?? "",
        model,
        content,
        maxCharacters,
        automationId: job.automationId,
        eventId: job.eventId,
      });
      return result.summary;
    },
    writer: {
      path: job.outputPath,
      async read() {
        try {
          const existing = await readMarkdownFile(env.GITHUB_VAULT_TOKEN, vault, job.outputPath);
          return { sha: existing.sha, content: existing.content };
        } catch (error) {
          if (error instanceof GitHubError && error.status === 404) return undefined;
          throw error;
        }
      },
      async write(request) {
        await assertAutomationJobCanWrite(env.EVENT_DB, job.runId, leaseToken);
        const result = await writeMarkdownFile(
          env.GITHUB_VAULT_TOKEN,
          vault,
          job.outputPath,
          request.content,
          request.expectedSha,
        );
        await assertAutomationJobCanWrite(env.EVENT_DB, job.runId, leaseToken);
        return {
          contentSha: result.contentSha,
          commitSha: result.commitSha,
          created: result.created,
        };
      },
    },
  });
}

async function scheduleRetry(env: Env, job: AutomationJobRecord, leaseToken: string, code: string): Promise<void> {
  const delaySeconds = Math.min(15 * 60, 30 * 2 ** Math.min(job.attempts - 1, 5));
  const retryAt = new Date(Date.now() + delaySeconds * 1_000);
  const finished = await finishAutomationJob(env.EVENT_DB, job.runId, leaseToken, {
    status: "failed_retryable",
    errorCode: code,
    retryAt,
  });
  if (!finished) throw new AutomationJobWriteFenceError(job.runId);
  await env.AUTOMATIONS_QUEUE.send({ kind: "automation", runId: job.runId }, { delaySeconds });
  await markAutomationJobDispatched(env.EVENT_DB, job.runId);
}

async function finish(
  env: Env,
  job: AutomationJobRecord,
  leaseToken: string,
  status: "succeeded" | "failed_terminal" | "conflict" | "skipped_superseded",
  errorCode?: string,
): Promise<void> {
  const finished = await finishAutomationJob(env.EVENT_DB, job.runId, leaseToken, { status, errorCode });
  if (!finished) throw new AutomationJobWriteFenceError(job.runId);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AutomationProviderError) return error.retryable;
  if (error instanceof GitHubError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError;
}

function isConflict(error: unknown): boolean {
  if (error instanceof GitHubError && (error.status === 409 || error.status === 422)) return true;
  if (!(error instanceof Error)) return false;
  return error.message.includes("is not managed")
    || error.message.includes("managed by another automation")
    || error.message.includes("changed since it was read")
    || error.message.includes("already exists");
}

function errorCode(error: unknown): string {
  if (error instanceof AutomationProviderError) return error.code;
  if (error instanceof GitHubError) return `github_${error.status}`;
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unexpected_error";
}
