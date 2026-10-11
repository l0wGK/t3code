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
 * that prefix carries the token.
 *
 * Configure with `<stateDir>/desktop.json`:
 *
 *   {
 *     "upstream": "http://127.0.0.1:6080",   // websockify --web <novnc dir>
 *     "vncPassword": "..."                     // optional, passed to noVNC
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

export interface DesktopViewerConfig {
  readonly upstream: string;
  readonly vncPassword: string | null;
}

export function parseDesktopViewerConfig(raw: string): DesktopViewerConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const upstream =
    typeof record.upstream === "string" && record.upstream.trim()
      ? record.upstream.trim().replace(/\/+$/, "")
      : DEFAULT_UPSTREAM;
  if (!/^https?:\/\//.test(upstream)) return null;
  const vncPassword =
    typeof record.vncPassword === "string" && record.vncPassword ? record.vncPassword : null;
  return { upstream, vncPassword };
}

export function makeDesktopSessionToken(nowMs: number, secret: Uint8Array): string {
  const payload = base64UrlEncode(JSON.stringify({ exp: nowMs + SESSION_TTL_MS }));
  return `${payload}.${signPayload(payload, secret)}`;
}

export function verifyDesktopSessionToken(
  token: string,
  nowMs: number,
  secret: Uint8Array,
): boolean {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return false;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return false;
  try {
    const claims: unknown = JSON.parse(base64UrlDecodeUtf8(payload));
    return (
      typeof claims === "object" &&
      claims !== null &&
      typeof (claims as { exp?: unknown }).exp === "number" &&
      nowMs < (claims as { exp: number }).exp
    );
  } catch {
    return false;
  }
}

/**
 * The noVNC page for a session, with its WebSocket routed back through the
 * session prefix. `vnc_lite.html` keeps no settings in storage, so it runs in a
 * sandboxed (opaque-origin) frame. The password rides in the fragment, which
 * never reaches the server.
 */
export function desktopViewerLocation(token: string, vncPassword: string | null): string {
  const sessionPath = `${SESSION_PATH_PREFIX}${token}`;
  const params = new URLSearchParams({
    scale: "1",
    // noVNC joins `path` onto the page's host, without a leading slash.
    path: `${sessionPath.slice(1)}${WEBSOCKET_PATH}`,
  });
  // vnc_lite only reads a variable that follows `?` or `&`, even in the fragment.
  const fragment =
    vncPassword === null ? "" : `#&${new URLSearchParams({ password: vncPassword }).toString()}`;
  return `${sessionPath}/vnc_lite.html?${params.toString()}${fragment}`;
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

  if (pathname === `${DESKTOP_ROUTE_PREFIX}/open`) {
    if (request.method !== "GET") {
      return HttpServerResponse.text("Method Not Allowed", { status: 405 });
    }
    yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
    return HttpServerResponse.redirect(
      desktopViewerLocation(makeDesktopSessionToken(nowMs, secret), config.vncPassword),
      { status: 302, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
    );
  }

  const session = parseDesktopSessionPath(pathname);
  if (session === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  if (!verifyDesktopSessionToken(session.token, nowMs, secret)) {
    return HttpServerResponse.text("Desktop session expired", { status: 401 });
  }
  if (isWebSocketUpgrade(request)) {
    if (session.upstreamPath !== WEBSOCKET_PATH) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* proxyWebSocket(
      request,
      `${config.upstream.replace(/^http/, "ws")}${WEBSOCKET_PATH}`,
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  if (!STATIC_PATH.test(session.upstreamPath)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  return yield* proxyStatic(request, `${config.upstream}${session.upstreamPath}`).pipe(
    // A stopped viewer would otherwise surface as a bare 500 and a blank panel.
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text(
          `Desktop viewer is not running: nothing answered at ${config.upstream}. ` +
            "On the server, start it with: systemctl --user start t3-desktop",
          { status: 502 },
        ),
      ),
    ),
  );
});

export const layer = HttpRouter.add("*", `${DESKTOP_ROUTE_PREFIX}/*`, handler);
