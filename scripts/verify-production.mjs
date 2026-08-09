const rawOrigin = process.env.PRODUCTION_ORIGIN?.trim();
if (!rawOrigin) fail("PRODUCTION_ORIGIN is required");

let origin;
try {
  const parsed = new URL(rawOrigin);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail("PRODUCTION_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment");
  }
  origin = parsed.origin;
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Production verification error:")) throw error;
  fail("PRODUCTION_ORIGIN must be a valid HTTPS origin");
}

const healthUrl = new URL("/healthz", origin);
const attempts = 6;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(healthUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const health = await response.json();
      if (health?.ok === true && health?.service === "obsidian-vault-mcp") {
        console.log(`Production health verified at ${healthUrl}`);
        process.exit(0);
      }
    }
    console.error(`Production health attempt ${attempt}/${attempts} returned HTTP ${response.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    console.error(`Production health attempt ${attempt}/${attempts} failed: ${message}`);
  }
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5_000));
}

fail(`health check did not become ready at ${healthUrl}`);

function fail(message) {
  throw new Error(`Production verification error: ${message}`);
}
