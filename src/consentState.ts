export type ConsentState<T> =
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "valid"; value: T };

const consentStatePrefix = "oauth-consent-state:";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function storeConsentState<T>(kv: KVNamespace, consentId: string, value: T, expirationTtl: number): Promise<void> {
  await kv.put(`${consentStatePrefix}${consentId}`, JSON.stringify(value), { expirationTtl });
}

export async function consumeConsentState<T>(kv: KVNamespace, consentId: FormDataEntryValue | null): Promise<ConsentState<T>> {
  if (typeof consentId !== "string" || !uuidPattern.test(consentId)) return { status: "invalid" };

  const key = `${consentStatePrefix}${consentId}`;
  const stored = await kv.get(key);
  await kv.delete(key);
  if (!stored) return { status: "expired" };

  try {
    return { status: "valid", value: JSON.parse(stored) as T };
  } catch {
    return { status: "expired" };
  }
}
