export function isLoopbackRedirect(value: string): boolean {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    return false;
  }

  if (redirect.protocol !== "http:" && redirect.protocol !== "https:") return false;
  const hostname = redirect.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function loopbackHandoffPage(redirectTo: string): string {
  if (!isLoopbackRedirect(redirectTo)) throw new Error("OAuth redirect is not a loopback URL");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Access granted</title></head>
<body><main><h1>Access granted</h1>
<p>Your vault access was approved. Finish the connection in Codex.</p>
<p><a href="${escapeHtml(redirectTo)}" target="_blank" rel="noopener noreferrer">Finish in Codex</a></p>
<p>If Codex is still starting, wait a moment and use the same button again.</p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}
