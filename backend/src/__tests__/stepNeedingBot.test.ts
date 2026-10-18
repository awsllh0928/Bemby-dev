// Which steps a custom job can run without a target bot. The rule is checked before the
// client is even built, so getting it wrong stops a job that would have worked -- which is
// how "open this Mini App address" came to demand a bot it had no use for.
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { stepNeedingBot } from "../jobs/custom";
import type { CustomAction } from "../types";

const url = "https://web.example-media.org/app";

describe("stepNeedingBot", () => {
  it("lets a Mini App address run with no bot anywhere, which is the point of typing one", () => {
    expect(stepNeedingBot([{ type: "open_mini_app_url", url } as CustomAction], "")).toBeNull();
  });

  it("still lets it run when a bot is named, since that is the signing path", () => {
    expect(
      stepNeedingBot([{ type: "open_mini_app_url", url } as CustomAction], "some_bot"),
    ).toBeNull();
  });

  it("holds the line for a step that presses a button in a chat", () => {
    // open_mini_app hunts for a button in a conversation, so it needs to know whose
    expect(stepNeedingBot([{ type: "open_mini_app" } as CustomAction], "")).toEqual({
      at: 0,
      type: "open_mini_app",
    });
    // ...unless the step names its own contact
    expect(
      stepNeedingBot([{ type: "open_mini_app", contact: "@bot" } as CustomAction], ""),
    ).toBeNull();
  });

  it("holds the line for the bot's menu button, which is nothing without a bot", () => {
    // There is no address to fall back on: the bot has to be asked what it pins
    expect(stepNeedingBot([{ type: "open_bot_menu_app" } as CustomAction], "")).toEqual({
      at: 0,
      type: "open_bot_menu_app",
    });
    expect(
      stepNeedingBot([{ type: "open_bot_menu_app", contact: "@misayamidiabot" } as CustomAction], ""),
    ).toBeNull();
    expect(stepNeedingBot([{ type: "open_bot_menu_app" } as CustomAction], "a_bot")).toBeNull();
  });

  it("names the first step that cannot run, counting from the whole list", () => {
    const actions = [
      { type: "delay", waitMs: 1 },
      { type: "open_mini_app_url", url },
      { type: "send_command" },
    ] as CustomAction[];
    expect(stepNeedingBot(actions, "")).toEqual({ at: 2, type: "send_command" });
  });

  it("asks nothing of any step once the job has a bot", () => {
    const actions = [{ type: "send_command" }, { type: "open_mini_app" }] as CustomAction[];
    expect(stepNeedingBot(actions, "a_bot")).toBeNull();
    expect(stepNeedingBot(actions, "  ")).not.toBeNull();
  });

  it("passes a job with no steps at all", () => {
    expect(stepNeedingBot([], "")).toBeNull();
  });
});
