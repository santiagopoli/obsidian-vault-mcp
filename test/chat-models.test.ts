import { describe, expect, it } from "vitest";
import { chatModelIds, chatModels, defaultChatModel, reasoningEfforts } from "../src/chatModels";
import type { Env } from "../src/types";

describe("vault chat model configuration", () => {
  it("exposes exactly the supported ChatGPT models and reasoning levels", () => {
    expect(chatModels.map(({ id }) => id)).toEqual(chatModelIds);
    expect(chatModelIds).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(reasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("accepts only an allowlisted deployment default", () => {
    expect(defaultChatModel({ OPENAI_CHAT_MODEL: "gpt-5.6-terra" } as Env)).toBe("gpt-5.6-terra");
    expect(() => defaultChatModel({ OPENAI_CHAT_MODEL: "untrusted-model" } as Env)).toThrow("allowlisted");
  });
});
