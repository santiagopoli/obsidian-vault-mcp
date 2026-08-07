import { describe, expect, it } from "vitest";
import {
  GitHubWebhookError,
  assertGitHubPushRef,
  assertGitHubWebhookBodySize,
  assertGitHubWebhookRepository,
  assertSupportedGitHubWebhookEvent,
  readGitHubWebhookHeaders,
  safeEqualBytes,
  validateGitHubWebhook,
  verifyGitHubWebhookSignature,
} from "../src/githubWebhook";
import type { GitHubWebhookPolicy } from "../src/githubWebhook";

const encoder = new TextEncoder();
const secret = "It's a Secret to Everybody";
const deliveryId = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
const repositoryId = "1296269";
const hookId = "292430182";
const mainRef = "refs/heads/main";
const policy: GitHubWebhookPolicy = {
  secret,
  hookId,
  repositoryId,
  defaultBranchRef: mainRef,
};

describe("GitHub webhook signatures", () => {
  it("matches GitHub's official HMAC-SHA256 test vector over raw bytes", async () => {
    const body = encoder.encode("Hello, World!");
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

    expect(await verifyGitHubWebhookSignature(body, signature, secret)).toBe(true);
    expect(await verifyGitHubWebhookSignature(encoder.encode("Hello, World?"), signature, secret)).toBe(false);
    expect(await verifyGitHubWebhookSignature(body, signature, "wrong secret")).toBe(false);
  });

  it.each(["", "sha1=abc", "sha256=xyz", `sha256=${"a".repeat(63)}`])(
    "rejects malformed signature %j",
    async (signature) => expect(await verifyGitHubWebhookSignature(encoder.encode("body"), signature, secret)).toBe(false),
  );

  it("rejects an empty verification secret as invalid server policy", async () => {
    await expectErrorAsync(
      verifyGitHubWebhookSignature(encoder.encode("body"), `sha256=${"0".repeat(64)}`, ""),
      "invalid_policy",
      500,
    );
  });

  it("signs the exact UTF-8 body rather than parsed or normalized JSON", async () => {
    const first = encoder.encode('{"message":"café","value":1}');
    const second = encoder.encode('{ "message": "café", "value": 1 }');
    const signature = await sign(first, secret);

    expect(await verifyGitHubWebhookSignature(first, signature, secret)).toBe(true);
    expect(await verifyGitHubWebhookSignature(second, signature, secret)).toBe(false);
  });

  it("compares equal bytes without early length acceptance", () => {
    expect(safeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(safeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(safeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(safeEqualBytes(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe("GitHub webhook envelope", () => {
  it("reads required delivery metadata and permits a JSON charset", () => {
    const headers = webhookHeaders("push", "sha256=" + "a".repeat(64));
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Length", "123");

    expect(readGitHubWebhookHeaders(headers)).toEqual({
      deliveryId,
      event: "push",
      hookId,
      signature: "sha256=" + "a".repeat(64),
    });
  });

  it.each([
    "content-type",
    "x-github-delivery",
    "x-github-event",
    "x-github-hook-id",
    "x-hub-signature-256",
  ])("rejects a missing %s header", (name) => {
    const headers = webhookHeaders("push", "sha256=" + "a".repeat(64));
    headers.delete(name);

    expectError(() => readGitHubWebhookHeaders(headers), "missing_header", 400);
  });

  it.each([
    ["content-type", "application/x-www-form-urlencoded", "unsupported_content_type", 415],
    ["x-github-delivery", "not-a-guid", "invalid_header", 400],
    ["x-github-event", "Push Event", "invalid_header", 400],
    ["x-github-hook-id", "0", "invalid_header", 400],
    ["x-hub-signature-256", "sha256=short", "invalid_header", 400],
    ["content-length", "NaN", "invalid_header", 400],
    ["content-encoding", "gzip", "invalid_header", 400],
  ])("rejects invalid %s", (name, value, code, status) => {
    const headers = webhookHeaders("push", "sha256=" + "a".repeat(64));
    headers.set(String(name), String(value));

    expectError(() => readGitHubWebhookHeaders(headers), String(code), Number(status));
  });

  it("rejects declared and actual bodies above the configured budget", () => {
    const headers = webhookHeaders("push", "sha256=" + "a".repeat(64));
    headers.set("Content-Length", "11");

    expectError(() => readGitHubWebhookHeaders(headers, 10), "body_too_large", 413);
    expectError(() => assertGitHubWebhookBodySize(new Uint8Array(11), 10), "body_too_large", 413);
    expectError(() => assertGitHubWebhookBodySize(new Uint8Array(), 0), "invalid_policy", 500);
  });
});

describe("GitHub webhook payload validation", () => {
  it("validates and normalizes an allowed push", async () => {
    const payload = pushPayload();
    const request = await signedRequest("push", payload);

    await expect(validateGitHubWebhook(request.headers, request.body, policy)).resolves.toMatchObject({
      deliveryId,
      hookId,
      repositoryId,
      event: "push",
      ref: mainRef,
      before: "1".repeat(40),
      after: "2".repeat(40),
      forced: false,
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("validates a repository ping without requiring push fields", async () => {
    const request = await signedRequest("ping", { zen: "Keep it logically awesome.", repository: { id: 1296269 } });

    await expect(validateGitHubWebhook(request.headers, request.body, policy)).resolves.toMatchObject({
      deliveryId,
      hookId,
      repositoryId,
      event: "ping",
    });
  });

  it("checks the hook ID before trusting a validly signed payload", async () => {
    const request = await signedRequest("push", pushPayload());
    request.headers.set("X-GitHub-Hook-ID", "999");

    await expectErrorAsync(validateGitHubWebhook(request.headers, request.body, policy), "hook_mismatch", 403);
  });

  it("checks the signature before parsing attacker-controlled JSON", async () => {
    const body = encoder.encode("not json");
    const headers = webhookHeaders("push", "sha256=" + "0".repeat(64));

    await expectErrorAsync(validateGitHubWebhook(headers, body, policy), "invalid_signature", 401);
  });

  it("rejects malformed JSON after authenticating the exact bytes", async () => {
    const body = encoder.encode("not json");
    const headers = webhookHeaders("push", await sign(body, secret));

    await expectErrorAsync(validateGitHubWebhook(headers, body, policy), "invalid_payload", 400);
  });

  it("rejects invalid UTF-8 and non-object JSON after authenticating", async () => {
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    const invalidUtf8Headers = webhookHeaders("push", await sign(invalidUtf8, secret));
    const arrayBody = encoder.encode("[]");
    const arrayHeaders = webhookHeaders("push", await sign(arrayBody, secret));

    await expectErrorAsync(validateGitHubWebhook(invalidUtf8Headers, invalidUtf8, policy), "invalid_payload", 400);
    await expectErrorAsync(validateGitHubWebhook(arrayHeaders, arrayBody, policy), "invalid_payload", 400);
  });

  it("rejects a repository ID that is not a positive safe JSON integer", async () => {
    const stringId = await signedRequest("push", pushPayload({ repository: { id: repositoryId } }));
    const unsafeId = await signedRequest("push", pushPayload({ repository: { id: Number.MAX_SAFE_INTEGER + 1 } }));

    await expectErrorAsync(validateGitHubWebhook(stringId.headers, stringId.body, policy), "invalid_payload", 400);
    await expectErrorAsync(validateGitHubWebhook(unsafeId.headers, unsafeId.body, policy), "invalid_payload", 400);
  });

  it("rejects unsupported authenticated events", async () => {
    const request = await signedRequest("issues", { repository: { id: 1296269 } });

    await expectErrorAsync(validateGitHubWebhook(request.headers, request.body, policy), "unsupported_event", 400);
  });

  it("rejects authenticated events for a different repository", async () => {
    const request = await signedRequest("push", pushPayload({ repository: { id: 999 } }));

    await expectErrorAsync(validateGitHubWebhook(request.headers, request.body, policy), "repository_mismatch", 403);
  });

  it("rejects noncanonical branch and tag pushes", async () => {
    const feature = await signedRequest("push", pushPayload({ ref: "refs/heads/feature" }));
    const tag = await signedRequest("push", pushPayload({ ref: "refs/tags/v1" }));

    await expectErrorAsync(validateGitHubWebhook(feature.headers, feature.body, policy), "ref_mismatch", 403);
    await expectErrorAsync(validateGitHubWebhook(tag.headers, tag.body, policy), "invalid_payload", 400);
  });

  it.each([
    { before: "short" },
    { after: "g".repeat(40) },
    { forced: "false" },
  ])("rejects malformed push revision fields", async (change) => {
    const request = await signedRequest("push", pushPayload(change));

    await expectErrorAsync(validateGitHubWebhook(request.headers, request.body, policy), "invalid_payload", 400);
  });

  it("accepts all-zero revisions used for ref creation or deletion", async () => {
    const request = await signedRequest("push", pushPayload({ before: "0".repeat(40), after: "0".repeat(40), forced: true }));

    await expect(validateGitHubWebhook(request.headers, request.body, policy)).resolves.toMatchObject({
      before: "0".repeat(40),
      after: "0".repeat(40),
      forced: true,
    });
  });

  it("exposes focused event, repository, and ref helpers", () => {
    const payload = pushPayload();

    expect(assertSupportedGitHubWebhookEvent("push")).toBe("push");
    expect(assertGitHubWebhookRepository(payload, repositoryId)).toBe(repositoryId);
    expect(assertGitHubPushRef(payload, mainRef)).toBe(mainRef);
    expectError(() => assertSupportedGitHubWebhookEvent("issues"), "unsupported_event", 400);
  });
});

function pushPayload(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: mainRef,
    before: "1".repeat(40),
    after: "2".repeat(40),
    forced: false,
    repository: { id: 1296269 },
    ...change,
  };
}

async function signedRequest(event: string, payload: unknown): Promise<{ headers: Headers; body: Uint8Array }> {
  const body = encoder.encode(JSON.stringify(payload));
  return { headers: webhookHeaders(event, await sign(body, secret)), body };
}

function webhookHeaders(event: string, signature: string): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Delivery": deliveryId,
    "X-GitHub-Event": event,
    "X-GitHub-Hook-ID": hookId,
    "X-Hub-Signature-256": signature,
  });
}

async function sign(body: Uint8Array, signingSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(body)));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function expectError(action: () => unknown, code: string, status: number): void {
  try {
    action();
    throw new Error("Expected GitHubWebhookError");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubWebhookError);
    expect(error).toMatchObject({ code, status });
  }
}

async function expectErrorAsync(action: Promise<unknown>, code: string, status: number): Promise<void> {
  try {
    await action;
    throw new Error("Expected GitHubWebhookError");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubWebhookError);
    expect(error).toMatchObject({ code, status });
  }
}
