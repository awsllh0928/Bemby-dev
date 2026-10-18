// The same model id can exist under multiple suppliers (e.g. two accounts of
// the same provider). Credential resolution must prefer a supplier with a key,
// and fallback must try the other supplier's copy rather than skipping it.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { callAI, recognizeCaptchaWithAI } from "../jobs/checkin";
import { setSetting } from "../db/repos/settings";
import { aiModelDoc, insert, supplierDoc, useTestDb } from "./helpers/db";

const MODEL = "some/vision-model";
const IMG = "data:image/png;base64,abc";

// Ids are explicit rather than read back: a test needs to pin a model row by id, and the
// only way to name it is to choose it.
async function insertSupplier(
  id: number,
  name: string,
  apiKey: string,
  modelIds: string[],
): Promise<void> {
  await insert("ai_suppliers", [
    supplierDoc({
      _id: id,
      name,
      base_url: `https://api.${name.replace(/\s+/g, "")}.test/v1`,
      api_key: apiKey,
    }),
  ]);
  await insert(
    "ai_models",
    modelIds.map((model_id, i) => aiModelDoc({ _id: id * 100 + i, supplier_id: id, model_id })),
  );
}

const modelRowId = (supplierId: number) => supplierId * 100;

function aiResponse(text: string, finishReason = "stop") {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finishReason }] }),
    { status: 200 },
  );
}

const fetchMock = vi.fn<typeof fetch>();

function authKeyOfCall(call: number): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string>)?.Authorization?.replace("Bearer ", "");
}

useTestDb();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
});

beforeEach(async () => {
  fetchMock.mockReset();
  await setSetting("ai_model", MODEL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", fetchMock);
});

describe("credential resolution with duplicate model ids", () => {
  it("prefers a supplier with a non-empty key over an earlier keyless one", async () => {
    await insertSupplier(1, "vercel", "", [MODEL]);
    await insertSupplier(2, "vercel 2", "key-2", [MODEL]);
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt");

    expect(authKeyOfCall(0)).toBe("key-2");
  });
});

describe("pinned default model (ai_default_model_id)", () => {
  it("uses the pinned supplier's key even when an earlier supplier has one", async () => {
    await insertSupplier(1, "vercel", "key-1", [MODEL]);
    await insertSupplier(2, "vercel 2", "key-2", [MODEL]);
    await setSetting("ai_default_model_id", String(modelRowId(2)));
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt");

    expect(authKeyOfCall(0)).toBe("key-2");
  });

  it("makes the pinned account primary and the other the fallback", async () => {
    await insertSupplier(1, "vercel", "key-1", [MODEL]);
    await insertSupplier(2, "vercel 2", "key-2", [MODEL]);
    await setSetting("ai_default_model_id", String(modelRowId(2)));
    fetchMock
      .mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }))
      .mockResolvedValueOnce(aiResponse("ABCD"));

    const result = await recognizeCaptchaWithAI([IMG]);

    expect(result.text).toBe("ABCD");
    expect(authKeyOfCall(0)).toBe("key-2");
    expect(authKeyOfCall(1)).toBe("key-1");
  });

  it("falls back to model-string resolution when the pinned row is gone", async () => {
    await insertSupplier(1, "vercel", "key-1", [MODEL]);
    await setSetting("ai_default_model_id", "9999");
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt");

    expect(authKeyOfCall(0)).toBe("key-1");
  });

  it("ignores the pin when an explicit model override is given", async () => {
    await insertSupplier(1, "vercel", "key-1", [MODEL]);
    await insertSupplier(2, "other", "key-other", ["other/model"]);
    await setSetting("ai_default_model_id", String(modelRowId(1)));
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt", 200, "other/model");

    expect(authKeyOfCall(0)).toBe("key-other");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("other/model");
  });
});

describe("reasoning-model responses", () => {
  it("strips inline <think> chain-of-thought from the answer", async () => {
    await insertSupplier(1, "deepseek", "key-1", [MODEL]);
    fetchMock.mockResolvedValueOnce(aiResponse("<think>the code reads 1 2 3 4</think>1234"));

    const result = await recognizeCaptchaWithAI([IMG]);

    expect(result.text).toBe("1234");
  });

  it("gives a clear error when the token budget is exhausted before an answer", async () => {
    await insertSupplier(1, "deepseek", "key-1", [MODEL]);
    await setSetting("ai_fallback_enabled", "false");
    fetchMock.mockResolvedValue(aiResponse("<think>still reasoning", "length"));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/finish_reason=length/);
  });

  it("sends a generous token budget so reasoning models can answer", async () => {
    await insertSupplier(1, "deepseek", "key-1", [MODEL]);
    fetchMock.mockResolvedValueOnce(aiResponse("ABCD"));

    await recognizeCaptchaWithAI([IMG]);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1000);
  });
});

describe("fallback across suppliers sharing a model id", () => {
  it("tries the second supplier's copy of the same model when the first fails", async () => {
    await insertSupplier(1, "vercel", "key-1", [MODEL]);
    await insertSupplier(2, "vercel 2", "key-2", [MODEL]);
    fetchMock
      .mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }))
      .mockResolvedValueOnce(aiResponse("ABCD"));

    const result = await recognizeCaptchaWithAI([IMG]);

    expect(result.text).toBe("ABCD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authKeyOfCall(0)).toBe("key-1");
    expect(authKeyOfCall(1)).toBe("key-2");
  });

  it("does not retry identical credentials twice", async () => {
    await insertSupplier(1, "vercel", "key-1", [MODEL]);
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/AI API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips other suppliers when fallback is disabled", async () => {
    await insertSupplier(1, "vercel", "key-1", [MODEL]);
    await insertSupplier(2, "vercel 2", "key-2", [MODEL]);
    await setSetting("ai_fallback_enabled", "false");
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/AI API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
