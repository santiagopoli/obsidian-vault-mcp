import type { Env } from "./types";

export const chatModelIds = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
export type ChatModelId = typeof chatModelIds[number];

export const reasoningEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];

export interface ChatModelOption {
  id: ChatModelId;
  label: string;
  description: string;
}

export const chatModels: ChatModelOption[] = [
  { id: "gpt-5.6-sol", label: "Sol", description: "Highest capability" },
  { id: "gpt-5.6-terra", label: "Terra", description: "Balanced intelligence and cost" },
  { id: "gpt-5.6-luna", label: "Luna", description: "Fast and efficient" },
];

export function defaultChatModel(env: Env): ChatModelId {
  const configured = env.OPENAI_CHAT_MODEL?.trim();
  if (!configured) return "gpt-5.6-sol";
  if (!isChatModel(configured)) throw new Error("OPENAI_CHAT_MODEL must be an allowlisted chat model");
  return configured;
}

export function isChatModel(value: unknown): value is ChatModelId {
  return typeof value === "string" && (chatModelIds as readonly string[]).includes(value);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (reasoningEfforts as readonly string[]).includes(value);
}
