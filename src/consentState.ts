export type ConsentState<T> =
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "valid"; value: T };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function storeConsentState<T>(db: D1Database, consentId: string, value: T, expirationTtl: number): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1_000) + expirationTtl;
  await db.prepare("INSERT INTO mcp_consent_states (consent_id_hash, payload, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(consentId), JSON.stringify(value), expiresAt)
    .run();
}

export async function consumeConsentState<T>(db: D1Database, consentId: FormDataEntryValue | null): Promise<ConsentState<T>> {
  if (typeof consentId !== "string" || !uuidPattern.test(consentId)) return { status: "invalid" };
  const row = await db.prepare(
    "DELETE FROM mcp_consent_states WHERE consent_id_hash = ? AND expires_at > ? RETURNING payload",
  ).bind(await sha256(consentId), Math.floor(Date.now() / 1_000)).first<{ payload: string }>();
  if (!row) return { status: "expired" };

  try {
    return { status: "valid", value: JSON.parse(row.payload) as T };
  } catch {
    return { status: "expired" };
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
