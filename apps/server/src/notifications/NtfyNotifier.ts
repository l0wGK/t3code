/**
 * Fork addition: sends ntfy (https://ntfy.sh) push notifications when a thread
 * finishes, fails, needs approval, or waits for input.
 *
 * It watches the same domain events and awareness projection as
 * AgentAwarenessRelay, but needs no T3 Connect link or Apple push entitlement:
 * the ntfy app on iOS/macOS/Android receives the alerts.
 *
 * Configure with `<stateDir>/ntfy.json` (re-read on every alert, so edits apply
 * without a restart):
 *
 *   {
 *     "server": "https://ntfy.sh",          // optional, defaults to ntfy.sh
 *     "topic": "my-unguessable-topic",
 *     "token": "tk_...",                     // optional access token
 *     "click": "t3code:/{deepLink}",         // optional; "" disables tap links
 *     "enabled": true                        // optional, defaults to true
 *   }
 */
import type {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import {
  projectThreadAwareness,
  type AgentAwarenessPhase,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { eventThreadId, shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { forkParked } from "../serverActivation.ts";

export class NtfyNotifier extends Context.Service<
  NtfyNotifier,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/notifications/NtfyNotifier") {}

export const NTFY_CONFIG_FILE = "ntfy.json";
const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
const DEFAULT_CLICK_TEMPLATE = "t3code:/{deepLink}";
// A run can pass through a terminal-looking state while the projector is mid-write
// (for example "completed" at session boot), so an alert must hold this long.
export const ALERT_CONFIRM_DELAY_MS = 3_000;
const SEND_TIMEOUT_MS = 10_000;

export type NtfyAlertPhase = Extract<
  AgentAwarenessPhase,
  "completed" | "failed" | "waiting_for_approval" | "waiting_for_input"
>;

export function isNtfyAlertPhase(phase: AgentAwarenessPhase | null): phase is NtfyAlertPhase {
  return (
    phase === "completed" ||
    phase === "failed" ||
    phase === "waiting_for_approval" ||
    phase === "waiting_for_input"
  );
}

export interface NtfyConfig {
  readonly server: string;
  readonly topic: string;
  readonly token: string | null;
  readonly click: string | null;
}

export function parseNtfyConfig(raw: string): NtfyConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.enabled === false) return null;
  const topic = typeof record.topic === "string" ? record.topic.trim() : "";
  if (!topic) return null;
  const server =
    typeof record.server === "string" && record.server.trim()
      ? record.server.trim().replace(/\/+$/, "")
      : DEFAULT_NTFY_SERVER;
  const token =
    typeof record.token === "string" && record.token.trim() ? record.token.trim() : null;
  const click =
    typeof record.click === "string" ? record.click.trim() || null : DEFAULT_CLICK_TEMPLATE;
  return { server, topic, token, click };
}

export interface NtfyPendingAlert {
  readonly phase: NtfyAlertPhase;
  readonly dueAt: number;
}

export type NtfyAlertDecision =
  | { readonly kind: "clear" }
  | { readonly kind: "already-alerted" }
  | { readonly kind: "schedule"; readonly pending: NtfyPendingAlert }
  | { readonly kind: "wait" }
  | { readonly kind: "send"; readonly phase: NtfyAlertPhase };

/**
 * One alert per entry into an alert phase, and only once the phase has held for
 * ALERT_CONFIRM_DELAY_MS. Leaving alert phases clears the memory so the next
 * completion or approval alerts again.
 */
export function decideNtfyAlert(input: {
  readonly phase: AgentAwarenessPhase | null;
  readonly alerted: NtfyAlertPhase | undefined;
  readonly pending: NtfyPendingAlert | undefined;
  readonly nowMs: number;
}): NtfyAlertDecision {
  const { phase, alerted, pending, nowMs } = input;
  if (!isNtfyAlertPhase(phase)) return { kind: "clear" };
  if (alerted === phase) return { kind: "already-alerted" };
  if (pending === undefined || pending.phase !== phase) {
    return { kind: "schedule", pending: { phase, dueAt: nowMs + ALERT_CONFIRM_DELAY_MS } };
  }
  return nowMs < pending.dueAt ? { kind: "wait" } : { kind: "send", phase };
}

const PHASE_TAGS: Record<NtfyAlertPhase, string> = {
  completed: "white_check_mark",
  failed: "x",
  waiting_for_approval: "raised_hand",
  waiting_for_input: "question",
};

const PHASE_PRIORITY: Record<NtfyAlertPhase, number> = {
  completed: 3,
  failed: 4,
  waiting_for_approval: 4,
  waiting_for_input: 4,
};

/** The JSON body for ntfy's publish-as-JSON endpoint (POST to the server root). */
export function buildNtfyMessage(
  config: NtfyConfig,
  state: AgentAwarenessState & { readonly phase: NtfyAlertPhase },
) {
  return {
    topic: config.topic,
    title: `${state.headline} · ${state.projectTitle}`,
    message: state.detail ? `${state.threadTitle}\n${state.detail}` : state.threadTitle,
    tags: [PHASE_TAGS[state.phase]],
    priority: PHASE_PRIORITY[state.phase],
    ...(config.click ? { click: config.click.replaceAll("{deepLink}", state.deepLink) } : {}),
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const configPath = `${serverConfig.stateDir}/${NTFY_CONFIG_FILE}`;

  // The alert phase last delivered (or seeded at startup) per thread. Leaving an
  // alert phase clears the entry so the next completion alerts again.
  const alertedPhaseByThread = new Map<ThreadId, NtfyAlertPhase>();
  // An alert waiting out ALERT_CONFIRM_DELAY_MS before it is sent.
  const pendingAlerts = new Map<ThreadId, NtfyPendingAlert>();

  const readConfig = fs.readFileString(configPath).pipe(
    Effect.map(parseNtfyConfig),
    Effect.orElseSucceed(() => null),
  );

  const projectThread = (
    thread: Option.Option<OrchestrationThreadShell>,
    project: Option.Option<Pick<OrchestrationProjectShell, "title">>,
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(thread) || Option.isNone(project)) return null;
      if (thread.value.archivedAt !== null) return null;
      return projectThreadAwareness({
        environmentId: yield* serverEnvironment.getEnvironmentId,
        project: project.value,
        thread: thread.value,
      });
    });

  const send = Effect.fn("NtfyNotifier.send")(function* (
    state: AgentAwarenessState & { readonly phase: NtfyAlertPhase },
  ) {
    const config = yield* readConfig;
    if (config === null) return;
    const body = buildNtfyMessage(config, state);
    const request = HttpClientRequest.post(config.server).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      config.token ? HttpClientRequest.bearerToken(config.token) : (self) => self,
    );
    yield* HttpClient.HttpClient.pipe(
      Effect.flatMap((client) => client.pipe(HttpClient.filterStatusOk).execute(request)),
      Effect.timeout(SEND_TIMEOUT_MS),
      Effect.provide(FetchHttpClient.layer),
      Effect.tap(() =>
        Effect.logInfo("ntfy notification sent", { threadId: state.threadId, phase: state.phase }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("ntfy notification failed", { threadId: state.threadId, error }),
      ),
    );
  });

  let enqueue: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const processThread = Effect.fn("NtfyNotifier.processThread")(function* (threadId: ThreadId) {
    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    const project = Option.isSome(thread)
      ? yield* snapshotQuery.getProjectShellById(thread.value.projectId)
      : Option.none<OrchestrationProjectShell>();
    const state = yield* projectThread(thread, project);
    const phase = state?.phase ?? null;
    const decision = decideNtfyAlert({
      phase,
      alerted: alertedPhaseByThread.get(threadId),
      pending: pendingAlerts.get(threadId),
      nowMs: (yield* DateTime.now).epochMilliseconds,
    });
    switch (decision.kind) {
      case "clear":
        alertedPhaseByThread.delete(threadId);
        pendingAlerts.delete(threadId);
        return;
      case "already-alerted":
        pendingAlerts.delete(threadId);
        return;
      case "schedule":
        pendingAlerts.set(threadId, decision.pending);
        yield* Effect.forkIn(
          Effect.sleep(ALERT_CONFIRM_DELAY_MS).pipe(Effect.andThen(enqueue(threadId))),
          scope,
        );
        return;
      case "wait":
        return;
      case "send":
        pendingAlerts.delete(threadId);
        alertedPhaseByThread.set(threadId, decision.phase);
        if (state !== null) yield* send({ ...state, phase: decision.phase });
        return;
    }
  });

  // At most one queued entry per thread; updates during processing queue one more.
  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(
      Effect.andThen(processThread(threadId)),
      Effect.catchCause((cause) =>
        Effect.logWarning("ntfy thread processing failed", { threadId, cause }),
      ),
    ),
  );
  enqueue = (threadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId);
    });

  // Threads already waiting or finished when the server starts were either
  // alerted by a previous process or are history; only new transitions alert.
  const seedAlertedPhases = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
    for (const thread of snapshot.threads) {
      const state = yield* projectThread(
        Option.some(thread),
        Option.fromNullishOr(projectById.get(thread.projectId)),
      );
      if (state !== null && isNtfyAlertPhase(state.phase)) {
        alertedPhaseByThread.set(thread.id, state.phase);
      }
    }
  });

  const start: NtfyNotifier["Service"]["start"] = Effect.fn("NtfyNotifier.start")(function* () {
    yield* forkParked(
      seedAlertedPhases.pipe(
        Effect.catchCause((cause) => Effect.logWarning("ntfy startup seed failed", { cause })),
        Effect.andThen(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
            const threadId = eventThreadId(event);
            return threadId !== null && shouldPublishAgentAwarenessEvent(event)
              ? enqueue(threadId)
              : Effect.void;
          }),
        ),
      ),
    );
  });

  return NtfyNotifier.of({ start });
});

export const layer = Layer.effect(NtfyNotifier, make);

/** Starts the notifier as part of the server runtime. */
export const layerStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const notifier = yield* NtfyNotifier;
    yield* notifier.start();
  }),
).pipe(Layer.provide(layer));
