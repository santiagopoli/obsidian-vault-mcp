const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptCredential(secret: string, plaintext: string, context: string): Promise<string> {
  const key = await credentialKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(plaintext),
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptCredential(secret: string, encrypted: string, context: string): Promise<string> {
  const [ivValue, ciphertextValue, extra] = encrypted.split(".");
  if (!ivValue || !ciphertextValue || extra) throw new Error("sync_credential_invalid");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivValue), additionalData: encoder.encode(context) },
      await credentialKey(secret),
      fromBase64Url(ciphertextValue),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("sync_credential_invalid");
  }
}

export function validateCredentialCipherKey(secret: string): void {
  const bytes = fromBase64Url(secret);
  if (bytes.byteLength !== 32) throw new Error("SYNC_CREDENTIALS_KEY must be a base64-encoded 32-byte secret");
}

function credentialKey(secret: string): Promise<CryptoKey> {
  validateCredentialCipherKey(secret);
  const bytes = fromBase64Url(secret);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("sync_credential_invalid");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
