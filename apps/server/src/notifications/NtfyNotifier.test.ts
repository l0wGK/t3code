import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  ALERT_CONFIRM_DELAY_MS,
  buildNtfyMessage,
  decideNtfyAlert,
  isNtfyAlertPhase,
  parseNtfyConfig,
} from "./NtfyNotifier.ts";

describe("parseNtfyConfig", () => {
  it("applies defaults for a topic-only config", () => {
    assert.deepStrictEqual(parseNtfyConfig(`{"topic":" my-topic "}`), {
      server: "https://ntfy.sh",
      topic: "my-topic",
      token: null,
      click: "t3code:/{deepLink}",
    });
  });

  it("reads server, token and click, trimming a trailing slash", () => {
    assert.deepStrictEqual(
      parseNtfyConfig(
        `{"server":"https://ntfy.example.com/","topic":"t","token":"tk_1","click":"https://x{deepLink}"}`,
      ),
      {
        server: "https://ntfy.example.com",
        topic: "t",
        token: "tk_1",
        click: "https://x{deepLink}",
      },
    );
  });

  it("disables tap links with an empty click", () => {
    assert.strictEqual(parseNtfyConfig(`{"topic":"t","click":""}`)?.click, null);
  });

  it("returns null when disabled, missing a topic, or invalid", () => {
    assert.strictEqual(parseNtfyConfig(`{"topic":"t","enabled":false}`), null);
    assert.strictEqual(parseNtfyConfig(`{"topic":"  "}`), null);
    assert.strictEqual(parseNtfyConfig(`not json`), null);
    assert.strictEqual(parseNtfyConfig(`[]`), null);
  });
});

describe("isNtfyAlertPhase", () => {
  it("alerts only on phases that need the user", () => {
    assert.isTrue(isNtfyAlertPhase("completed"));
    assert.isTrue(isNtfyAlertPhase("failed"));
    assert.isTrue(isNtfyAlertPhase("waiting_for_approval"));
    assert.isTrue(isNtfyAlertPhase("waiting_for_input"));
    assert.isFalse(isNtfyAlertPhase("running"));
    assert.isFalse(isNtfyAlertPhase("starting"));
    assert.isFalse(isNtfyAlertPhase(null));
  });
});

describe("buildNtfyMessage", () => {
  const state = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    projectTitle: "My Project",
    threadTitle: "Fix the login bug",
    phase: "waiting_for_approval" as const,
    headline: "Approval needed",
    modelTitle: "claude-opus-5-5",
    updatedAt: "2026-10-11T00:00:00.000Z",
    deepLink: "/threads/env-1/thread-1",
  };

  it("builds a JSON publish body with a deep link", () => {
    assert.deepStrictEqual(buildNtfyMessage(parseNtfyConfig(`{"topic":"t"}`)!, state), {
      topic: "t",
      title: "Approval needed · My Project",
      message: "Fix the login bug",
      tags: ["raised_hand"],
      priority: 4,
      click: "t3code://threads/env-1/thread-1",
    });
  });

  it("includes detail and omits click when disabled", () => {
    const message = buildNtfyMessage(parseNtfyConfig(`{"topic":"t","click":""}`)!, {
      ...state,
      phase: "completed",
      headline: "Agent finished",
      detail: "Review the completed task.",
    });
    assert.strictEqual(message.message, "Fix the login bug\nReview the completed task.");
    assert.deepStrictEqual(message.tags, ["white_check_mark"]);
    assert.strictEqual(message.priority, 3);
    assert.notProperty(message, "click");
  });
});

describe("decideNtfyAlert", () => {
  const base = { alerted: undefined, pending: undefined, nowMs: 1_000 };

  it("schedules a confirmation when a thread enters an alert phase", () => {
    assert.deepStrictEqual(decideNtfyAlert({ ...base, phase: "completed" }), {
      kind: "schedule",
      pending: { phase: "completed", dueAt: 1_000 + ALERT_CONFIRM_DELAY_MS },
    });
  });

  it("waits until the confirmation is due, then sends", () => {
    const pending = { phase: "completed" as const, dueAt: 4_000 };
    assert.deepStrictEqual(
      decideNtfyAlert({ ...base, phase: "completed", pending, nowMs: 3_999 }),
      {
        kind: "wait",
      },
    );
    assert.deepStrictEqual(
      decideNtfyAlert({ ...base, phase: "completed", pending, nowMs: 4_000 }),
      {
        kind: "send",
        phase: "completed",
      },
    );
  });

  it("restarts the confirmation when the alert phase changes", () => {
    const pending = { phase: "waiting_for_approval" as const, dueAt: 4_000 };
    assert.deepStrictEqual(
      decideNtfyAlert({ ...base, phase: "completed", pending, nowMs: 5_000 }).kind,
      "schedule",
    );
  });

  it("does not repeat an alert for the same phase", () => {
    assert.deepStrictEqual(decideNtfyAlert({ ...base, phase: "completed", alerted: "completed" }), {
      kind: "already-alerted",
    });
  });

  it("clears when the agent resumes, so a transient completion never alerts", () => {
    assert.deepStrictEqual(
      decideNtfyAlert({
        ...base,
        phase: "running",
        pending: { phase: "completed", dueAt: 4_000 },
      }),
      { kind: "clear" },
    );
    assert.deepStrictEqual(decideNtfyAlert({ ...base, phase: null, alerted: "completed" }), {
      kind: "clear",
    });
  });
});
