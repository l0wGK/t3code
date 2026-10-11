/**
 * Fork addition: same-origin proxy in front of a noVNC viewer for the server
 * machine's GUI desktop, so the Desktop panel works over LAN, Tailscale, and
 * T3 Connect without exposing the VNC server itself.
 *
 * noVNC loads its scripts by relative URL and opens its WebSocket from a
 * `path` setting, neither of which can carry a header or a query ticket. So
 * `/api/desktop/open` authenticates like other media routes (cookie or
 * `wsTicket`, operate scope), then redirects to a session URL with a signed
 * token in the path: `/api/desktop/s/<token>/vnc.html`. Every request under
 * that prefix carries the token, and the token names the desktop it opens.
 *
 * Configure with `<stateDir>/desktop.json`, either one desktop:
 *
 *   {
 *     "upstream": "http://127.0.0.1:6080",   // websockify --web <novnc dir>
 *     "vncPassword": "..."                     // optional, passed to noVNC
 *   }
 *
 * or several, so agents can each drive their own (`?desktop=<index>` on open):
 *
 *   {
 *     "vncPassword": "...",
 *     "desktops": [
 *       { "name": "Desktop 1", "upstream": "http://127.0.0.1:6080" },
 *       { "name": "Desktop 2", "upstream": "http://127.0.0.1:6081" }
 *     ]
 *   }
 */
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { DESKTOP_VIEWER_PAGE, desktopViewerHtml } from "./viewerPage.ts";
import { authenticate as authenticateMediaRequest } from "../device/DeviceHubProxy.ts";

export const DESKTOP_ROUTE_PREFIX = "/api/desktop";
export const DESKTOP_CONFIG_FILE = "desktop.json";
const SESSION_PATH_PREFIX = `${DESKTOP_ROUTE_PREFIX}/s/`;
const SIGNING_SECRET_NAME = "desktop-viewer-signing-key";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_UPSTREAM = "http://127.0.0.1:6080";
// Static noVNC files only: no dot segments, no encoded separators.
const STATIC_PATH = /^\/(?:[\w-]+\/)*[\w.-]+$/;
const WEBSOCKET_PATH = "/websockify";

export interface DesktopTarget {
  readonly name: string;
  readonly upstream: string;
}

export interface DesktopViewerConfig {
  readonly desktops: ReadonlyArray<DesktopTarget>;
  readonly vncPassword: string | null;
}

const readUpstream = (value: unknown): string | null => {
  const upstream =
    typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : DEFAULT_UPSTREAM;
  return /^https?:\/\//.test(upstream) ? upstream : null;
};

export function parseDesktopViewerConfig(raw: string): DesktopViewerConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const vncPassword =
    typeof record.vncPassword === "string" && record.vncPassword ? record.vncPassword : null;
  if (!Array.isArray(record.desktops)) {
    const upstream = readUpstream(record.upstream);
    return upstream === null ? null : { desktops: [{ name: "Desktop", upstream }], vncPassword };
  }
  const desktops: DesktopTarget[] = [];
  for (const [index, entry] of record.desktops.entries()) {
    if (typeof entry !== "object" || entry === null) return null;
    const desktop = entry as Record<string, unknown>;
    const upstream = readUpstream(desktop.upstream);
    if (upstream === null) return null;
    const name =
      typeof desktop.name === "string" && desktop.name.trim()
        ? desktop.name.trim()
        : `Desktop ${index + 1}`;
    desktops.push({ name, upstream });
  }
  return desktops.length > 0 ? { desktops, vncPassword } : null;
}

export function makeDesktopSessionToken(nowMs: number, secret: Uint8Array, desktop = 0): string {
  const payload = base64UrlEncode(JSON.stringify({ exp: nowMs + SESSION_TTL_MS, desktop }));
  return `${payload}.${signPayload(payload, secret)}`;
}

/** The desktop index a valid session token opens, or null. */
export function verifyDesktopSessionToken(
  token: string,
  nowMs: number,
  secret: Uint8Array,
): number | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return null;
  try {
    const claims: unknown = JSON.parse(base64UrlDecodeUtf8(payload));
    if (typeof claims !== "object" || claims === null) return null;
    const { exp, desktop = 0 } = claims as { exp?: unknown; desktop?: unknown };
    if (typeof exp !== "number" || nowMs >= exp) return null;
    return Number.isInteger(desktop) && (desktop as number) >= 0 ? (desktop as number) : null;
  } catch {
    return null;
  }
}

/** Reads `?desktop=<index>`; absent means the first desktop. */
export function parseDesktopIndex(value: string | null, count: number): number | null {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return null;
  const index = Number(value);
  return index < count ? index : null;
}

/**
 * The viewer page for a session, with its WebSocket routed back through the
 * session prefix. The page runs in a sandboxed (opaque-origin) frame. The
 * password rides in the fragment, which never reaches the server.
 */
export function desktopViewerLocation(
  token: string,
  vncPassword: string | null,
  theme: "light" | "dark" | null = null,
): string {
  const sessionPath = `${SESSION_PATH_PREFIX}${token}`;
  const params = new URLSearchParams({
    // The page joins `path` onto its host, without a leading slash.
    path: `${sessionPath.slice(1)}${WEBSOCKET_PATH}`,
  });
  if (theme !== null) params.set("theme", theme);
  const fragment =
    vncPassword === null ? "" : `#&${new URLSearchParams({ password: vncPassword }).toString()}`;
  return `${sessionPath}${DESKTOP_VIEWER_PAGE}?${params.toString()}${fragment}`;
}

/** Splits `/api/desktop/s/<token>/<rest>` into its token and upstream path. */
export function parseDesktopSessionPath(
  pathname: string,
): { readonly token: string; readonly upstreamPath: string } | null {
  if (!pathname.startsWith(SESSION_PATH_PREFIX)) return null;
  const remainder = pathname.slice(SESSION_PATH_PREFIX.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) return null;
  return { token: remainder.slice(0, slash), upstreamPath: remainder.slice(slash) };
}

const parseTheme = (value: string | null): "light" | "dark" | null =>
  value === "light" || value === "dark" ? value : null;

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const proxyWebSocket = Effect.fn("DesktopViewerProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const client = yield* request.upgrade;
  // websockify negotiates the "binary" subprotocol; noVNC also accepts none.
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    protocols: ["binary"],
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const pumpFrames = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyStatic = Effect.fn("DesktopViewerProxy.proxyStatic")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* httpClient.execute(
    HttpClientRequest.make(request.method === "HEAD" ? "HEAD" : "GET")(upstreamUrl),
  );
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "last-modified", "etag"]) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  // Session URLs are secrets; keep them out of shared caches.
  headers["cache-control"] = "private, no-store";
  headers["referrer-policy"] = "no-referrer";
  // A sandboxed frame has an opaque origin, so its module scripts load in CORS
  // mode. The token in the path is the credential, not the origin.
  headers["access-control-allow-origin"] = "*";
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* fs.readFileString(`${serverConfig.stateDir}/${DESKTOP_CONFIG_FILE}`).pipe(
    Effect.map(parseDesktopViewerConfig),
    Effect.orElseSucceed(() => null),
  );
  if (config === null) {
    return HttpServerResponse.text("Desktop viewer is not configured", { status: 503 });
  }
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const secret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const nowMs = yield* Clock.currentTimeMillis;
  const pathname = url.value.pathname;

  if (pathname === `${DESKTOP_ROUTE_PREFIX}/list`) {
    if (request.method !== "GET") {
      return HttpServerResponse.text("Method Not Allowed", { status: 405 });
    }
    yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
    return HttpServerResponse.jsonUnsafe(
      { desktops: config.desktops.map(({ name }) => ({ name })) },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (pathname === `${DESKTOP_ROUTE_PREFIX}/open`) {
    if (request.method !== "GET") {
      return HttpServerResponse.text("Method Not Allowed", { status: 405 });
    }
    yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
    const desktop = parseDesktopIndex(
      url.value.searchParams.get("desktop"),
      config.desktops.length,
    );
    if (desktop === null) {
      return HttpServerResponse.text("No such desktop", { status: 404 });
    }
    return HttpServerResponse.redirect(
      desktopViewerLocation(
        makeDesktopSessionToken(nowMs, secret, desktop),
        config.vncPassword,
        parseTheme(url.value.searchParams.get("theme")),
      ),
      { status: 302, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
    );
  }

  const session = parseDesktopSessionPath(pathname);
  if (session === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const desktopIndex = verifyDesktopSessionToken(session.token, nowMs, secret);
  if (desktopIndex === null) {
    return HttpServerResponse.text("Desktop session expired", { status: 401 });
  }
  const target = config.desktops[desktopIndex];
  if (target === undefined) {
    return HttpServerResponse.text("No such desktop", { status: 404 });
  }
  if (isWebSocketUpgrade(request)) {
    if (session.upstreamPath !== WEBSOCKET_PATH) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* proxyWebSocket(
      request,
      `${target.upstream.replace(/^http/, "ws")}${WEBSOCKET_PATH}`,
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  if (session.upstreamPath === DESKTOP_VIEWER_PAGE) {
    return HttpServerResponse.text(desktopViewerHtml(), {
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
    });
  }
  if (!STATIC_PATH.test(session.upstreamPath)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  return yield* proxyStatic(request, `${target.upstream}${session.upstreamPath}`).pipe(
    // A stopped viewer would otherwise surface as a bare 500 and a blank panel.
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text(
          `${target.name} is not running: nothing answered at ${target.upstream}. ` +
            "On the server, check its service: systemctl --user status 't3-desktop*'",
          { status: 502 },
        ),
      ),
    ),
  );
});

export const layer = HttpRouter.add("*", `${DESKTOP_ROUTE_PREFIX}/*`, handler);
