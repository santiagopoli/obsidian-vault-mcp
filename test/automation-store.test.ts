import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import eventRuntimeMigration from "../migrations/0001_event_runtime.sql?raw";
import automationJobsMigration from "../migrations/0002_automation_jobs.sql?raw";
import {
  AutomationJobWriteFenceError,
  assertAutomationJobCanWrite,
  claimAutomationJob,
  enqueueAutomationJob,
  finishAutomationJob,
  listPendingAutomationJobs,
  markAutomationJobDispatched,
  type EnqueueAutomationJobInput,
} from "../src/automationStore";

const start = new Date("2026-08-07T10:00:00.000Z");

describe("durable automation jobs", () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2026-07-15",
      d1Databases: ["EVENT_DB"],
    });
    db = await runtime.getD1Database("EVENT_DB");
    await applyMigration(db, eventRuntimeMigration);
    await applyMigration(db, automationJobsMigration);
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  it("persists metadata without content and keeps the newest run as the source target", async () => {
    const first = await enqueueAutomationJob(db, job(), start);
    const duplicate = await enqueueAutomationJob(db, job(), later(1));
    const second = await enqueueAutomationJob(db, job({
      eventId: "event-2",
      sourceRevision: "c".repeat(40),
      sourceSha: "d".repeat(40),
    }), later(2));
    const replay = await enqueueAutomationJob(db, job(), later(3));

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.job.runId).toBe(first.job.runId);
    expect(second.currentTarget).toBe(true);
    expect(replay.currentTarget).toBe(false);

    const rows = await db.prepare(`
      SELECT run_id AS runId, status, source_sha AS sourceSha,
        output_path AS outputPath FROM automation_jobs ORDER BY job_sequence
    `).all<{ runId: string; status: string; sourceSha: string; outputPath: string }>();
    expect(rows.results).toEqual([
      expect.objectContaining({ runId: first.job.runId, status: "skipped_superseded", sourceSha: "b".repeat(40) }),
      expect.objectContaining({ runId: second.job.runId, status: "queued", outputPath: "Summaries/Note.md" }),
    ]);
    const columns = await db.prepare("PRAGMA table_info(automation_jobs)").all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).not.toContain("content");
  });

  it("lists only current due jobs and acknowledges outbox delivery idempotently", async () => {
    await enqueueAutomationJob(db, job(), start);
    const current = await enqueueAutomationJob(db, job({ eventId: "event-2", sourceSha: "c".repeat(40) }), later(1));

    expect((await listPendingAutomationJobs(db, 50, later(2))).map(({ runId }) => runId)).toEqual([current.job.runId]);
    expect(await markAutomationJobDispatched(db, current.job.runId, later(3))).toBe(true);
    expect(await markAutomationJobDispatched(db, current.job.runId, later(4))).toBe(false);
    expect(await listPendingAutomationJobs(db, 50, later(5))).toEqual([]);
  });

  it("claims once atomically and permits exactly one reclaim after lease expiry", async () => {
    const enqueued = await enqueueAutomationJob(db, job(), start);
    const contenders = await Promise.all([
      claimAutomationJob(db, enqueued.job.runId, { leaseToken: "worker-one", leaseDurationMs: 60_000, now: later(1) }),
      claimAutomationJob(db, enqueued.job.runId, { leaseToken: "worker-two", leaseDurationMs: 60_000, now: later(1) }),
    ]);
    const claimed = contenders.filter((value) => value !== undefined);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempts).toBe(1);
    expect(await claimAutomationJob(db, enqueued.job.runId, {
      leaseToken: "too-early",
      leaseDurationMs: 60_000,
      now: later(30),
    })).toBeUndefined();
    expect(await claimAutomationJob(db, enqueued.job.runId, {
      leaseToken: claimed[0]?.leaseToken ?? "missing-token",
      leaseDurationMs: 60_000,
      now: later(62),
    })).toBeUndefined();
    expect(await listPendingAutomationJobs(db, 50, later(62)))
      .toEqual([expect.objectContaining({ runId: enqueued.job.runId, status: "running" })]);

    const reclaimed = await claimAutomationJob(db, enqueued.job.runId, {
      leaseToken: "worker-three",
      leaseDurationMs: 60_000,
      now: later(62),
    });
    expect(reclaimed).toEqual(expect.objectContaining({ attempts: 2, leaseToken: "worker-three", status: "running" }));
  });

  it("requires both the current target and unexpired lease before an external write", async () => {
    const first = await enqueueAutomationJob(db, job(), start);
    await claimAutomationJob(db, first.job.runId, {
      leaseToken: "writer-one",
      leaseDurationMs: 120_000,
      now: later(1),
    });
    await expect(assertAutomationJobCanWrite(db, first.job.runId, "writer-one", later(2)))
      .resolves.toEqual(expect.objectContaining({ runId: first.job.runId, sourceSha: "b".repeat(40) }));

    await enqueueAutomationJob(db, job({ eventId: "event-2", sourceSha: "c".repeat(40) }), later(3));
    await expect(assertAutomationJobCanWrite(db, first.job.runId, "writer-one", later(4)))
      .rejects.toBeInstanceOf(AutomationJobWriteFenceError);
  });

  it("fences completion by lease token and schedules retryable jobs through the outbox", async () => {
    const enqueued = await enqueueAutomationJob(db, job(), start);
    await claimAutomationJob(db, enqueued.job.runId, {
      leaseToken: "first-token",
      leaseDurationMs: 10_000,
      now: later(1),
    });
    await claimAutomationJob(db, enqueued.job.runId, {
      leaseToken: "second-token",
      leaseDurationMs: 60_000,
      now: later(12),
    });

    expect(await finishAutomationJob(db, enqueued.job.runId, "first-token", {
      status: "succeeded",
      now: later(13),
    })).toBe(false);
    expect(await finishAutomationJob(db, enqueued.job.runId, "second-token", {
      status: "failed_retryable",
      errorCode: "provider_rate_limited",
      retryAt: later(60),
      now: later(14),
    })).toBe(true);
    expect(await listPendingAutomationJobs(db, 50, later(59))).toEqual([]);
    const pending = await listPendingAutomationJobs(db, 50, later(60));
    expect(pending).toEqual([expect.objectContaining({
      runId: enqueued.job.runId,
      status: "failed_retryable",
      errorCode: "provider_rate_limited",
    })]);
    expect(pending[0]?.leaseToken).toBeUndefined();
  });

  it("acknowledges a delayed retry as soon as the Queue accepts it", async () => {
    const enqueued = await enqueueAutomationJob(db, job(), start);
    await claimAutomationJob(db, enqueued.job.runId, {
      leaseToken: "retry-token",
      leaseDurationMs: 60_000,
      now: later(1),
    });
    await finishAutomationJob(db, enqueued.job.runId, "retry-token", {
      status: "failed_retryable",
      errorCode: "model_rate_limited",
      retryAt: later(60),
      now: later(2),
    });

    expect(await markAutomationJobDispatched(db, enqueued.job.runId, later(3))).toBe(true);
    expect(await listPendingAutomationJobs(db, 50, later(60))).toEqual([]);
  });

  it("rejects malformed durable metadata before touching D1", async () => {
    await expect(enqueueAutomationJob(db, job({ outputPath: "../escape.md" }), start))
      .rejects.toThrow("visible Markdown file");
    await expect(enqueueAutomationJob(db, job({ configHash: "A".repeat(64) }), start))
      .rejects.toThrow("lower-case 64-character hexadecimal");
    await expect(listPendingAutomationJobs(db, 101, start)).rejects.toThrow("between 1 and 100");
  });
});

function job(overrides: Partial<EnqueueAutomationJobInput> = {}): EnqueueAutomationJobInput {
  return {
    automationId: "summarize-note",
    handler: "summarize-note",
    configHash: "a".repeat(64),
    eventId: "event-1",
    repositoryId: "42",
    vault: "owner/vault",
    sourcePath: "Notes/Note.md",
    sourceRevision: "a".repeat(40),
    sourceSha: "b".repeat(40),
    outputPath: "Summaries/Note.md",
    ...overrides,
  };
}

function later(seconds: number): Date {
  return new Date(start.getTime() + seconds * 1_000);
}

async function applyMigration(db: D1Database, source: string): Promise<void> {
  for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
