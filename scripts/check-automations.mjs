import { readFile } from "node:fs/promises";
import { parseAutomationConfig } from "../src/automations/config.ts";

const path = process.argv[2] ?? "automations.example.yaml";
const source = await readFile(path, "utf8");
const config = parseAutomationConfig(source);
const enabled = config.automations.filter((automation) => automation.enabled);

console.log(`Valid automation configuration: ${enabled.length} enabled, ${config.automations.length} total`);
