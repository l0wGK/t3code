import type { EnvironmentId } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { Eye, EyeOff, Keyboard, PictureInPicture2, RotateCw } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";

type ThemeAppearance = "light" | "dark";

/**
 * The URL that opens a desktop viewer session. The server checks the media
 * ticket (or cookie) and redirects to a signed session URL; see
 * apps/server/src/desktop/DesktopViewerProxy.ts.
 */
export function desktopOpenUrl(
  access: DeviceHubAccess,
  theme?: ThemeAppearance,
  desktop = 0,
): string {
  const url = desktopApiUrl(access, "open");
  if (theme) url.searchParams.set("theme", theme);
  if (desktop > 0) url.searchParams.set("desktop", String(desktop));
  return url.toString();
}

function desktopApiUrl(access: DeviceHubAccess, route: "open" | "list"): URL {
  const url = new URL(access.httpBase.replace(/\/api\/device-hub\/?$/, `/api/desktop/${route}`));
  const ticket = access.query.wsTicket;
  if (ticket) url.searchParams.set("wsTicket", ticket);
  return url;
}

/** Names of the server's desktops, in index order; one entry on single-desktop servers. */
async function fetchDesktopNames(access: DeviceHubAccess): Promise<ReadonlyArray<string>> {
  // The ticket authenticates; cookies would make cross-origin clients (the desktop
  // app, app.t3.codes) fail CORS, which only allows uncredentialed requests.
  const response = await fetch(desktopApiUrl(access, "list"));
  // Servers from before multi-desktop support have no list route: one desktop.
  if (!response.ok) return [];
  const body: unknown = await response.json();
  const desktops = (body as { desktops?: unknown }).desktops;
  if (!Array.isArray(desktops)) return [];
  return desktops.map((desktop, index) =>
    typeof desktop?.name === "string" ? desktop.name : `Desktop ${index + 1}`,
  );
}

const POPOUT_TICKET_REFRESH_MS = 4 * 60_000;

type ViewerStatus = "connecting" | "reconnecting" | "connected" | "disconnected" | "error";

interface ViewerState {
  readonly status: ViewerStatus;
  readonly detail?: string;
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
}

const STATUS_LABELS: Record<ViewerStatus, string> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

/** Messages from the viewer page; see apps/server/src/desktop/viewerPage.ts. */
function readViewerMessage(
  data: unknown,
):
  | { type: "status"; state: ViewerState }
  | { type: "request-session" }
  | { type: "clipboard"; text: string }
  | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.source !== "t3-desktop-viewer") return null;
  if (message.type === "request-session") return { type: "request-session" };
  if (message.type === "clipboard" && typeof message.text === "string") {
    return { type: "clipboard", text: message.text };
  }
  if (message.type !== "status" || typeof message.status !== "string") return null;
  if (!(message.status in STATUS_LABELS)) return null;
  return {
    type: "status",
    state: {
      status: message.status as ViewerStatus,
      ...(typeof message.detail === "string" ? { detail: message.detail } : {}),
      ...(typeof message.name === "string" ? { name: message.name } : {}),
      ...(typeof message.width === "number" ? { width: message.width } : {}),
      ...(typeof message.height === "number" ? { height: message.height } : {}),
    },
  };
}

/**
 * Fork addition: the server machine's GUI desktop. The viewer runs in a frame
 * sandboxed without same-origin access, so it cannot reach this app; status and
 * controls cross over postMessage.
 */
export function DesktopPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const access = useDeviceHubAccess(props.environmentId);
  // Access cached before this panel mounted may hold an expired ticket, so the
  // frame waits for a fresh one. A missing value is already being minted.
  const staleAccessRef = useRef(access);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [viewer, setViewer] = useState<ViewerState>({ status: "connecting" });
  const [viewOnly, setViewOnly] = useState(false);
  // The theme the frame loaded with; later changes are sent over postMessage.
  const [initialTheme] = useState(resolvedTheme);
  const [desktopNames, setDesktopNames] = useState<ReadonlyArray<string>>([]);
  const [storedDesktop, setStoredDesktop] = useLocalStorage(
    `t3code:desktop-panel:desktop:${props.environmentId}`,
    0,
    Schema.Number,
  );
  // A remembered desktop the server no longer has falls back to the first.
  const desktop =
    desktopNames.length === 0 || storedDesktop < desktopNames.length ? storedDesktop : 0;

  useEffect(() => {
    if (staleAccessRef.current !== null) refreshDeviceHubAccess(props.environmentId);
  }, [props.environmentId, reloadCount]);

  const freshAccess = access !== null && access !== staleAccessRef.current ? access : null;
  // The frame keeps the URL it opened with; refreshed tickets only serve pop-outs.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (src !== null || freshAccess === null) return;
    setSrc(desktopOpenUrl(freshAccess, initialTheme, desktop));
    // Each session re-reads the list, so desktop.json edits show up on reconnect.
    fetchDesktopNames(freshAccess)
      .then(setDesktopNames)
      .catch(() => {});
  }, [src, freshAccess, initialTheme, desktop]);

  // Media tickets last five minutes, and a pop-out must open synchronously from
  // the click (Safari blocks later window.open calls), so keep one fresh.
  useEffect(() => {
    const timer = window.setInterval(
      () => refreshDeviceHubAccess(props.environmentId),
      POPOUT_TICKET_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [props.environmentId]);

  const popOut = () => {
    if (freshAccess === null) return;
    window.open(
      desktopOpenUrl(freshAccess, resolvedTheme, desktop),
      "_blank",
      "popup,width=1280,height=828,noopener,noreferrer",
    );
  };

  // A new session needs a fresh ticket, which also remounts the frame.
  const newSession = useCallback(() => {
    staleAccessRef.current = access;
    setSrc(null);
    setViewer({ status: "connecting" });
    setReloadCount((count) => count + 1);
  }, [access]);

  const switchDesktop = (next: number) => {
    if (next === desktop) return;
    setStoredDesktop(next);
    newSession();
  };

  const send = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ source: "t3-desktop-panel", ...message }, "*");
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return;
      const message = readViewerMessage(event.data);
      if (message === null) return;
      if (message.type === "request-session") newSession();
      // The frame copies too, but a plain-HTTP frame may lack clipboard access.
      else if (message.type === "clipboard")
        void navigator.clipboard?.writeText(message.text).catch(() => {});
      else setViewer((previous) => ({ ...previous, ...message.state }));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [newSession]);

  useEffect(() => send({ type: "theme", value: resolvedTheme }), [resolvedTheme, send]);
  useEffect(() => send({ type: "view-only", value: viewOnly }), [viewOnly, send]);
  useEffect(() => {
    if (props.visible) send({ type: "focus" });
  }, [props.visible, send]);

  const connected = viewer.status === "connected";
  const resolution = viewer.width && viewer.height ? `${viewer.width}×${viewer.height}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
        {desktopNames.length > 1 ? (
          <ToggleGroup
            aria-label="Desktop"
            className="shrink-0"
            variant="segmented"
            value={[String(desktop)]}
            onValueChange={(value) => {
              const next = Number(value[0]);
              if (Number.isInteger(next)) switchDesktop(next);
            }}
          >
            {desktopNames.map((name, index) => (
              <Tooltip key={index}>
                <TooltipTrigger render={<Toggle aria-label={name} value={String(index)} />}>
                  {index + 1}
                </TooltipTrigger>
                <TooltipPopup side="bottom">{name}</TooltipPopup>
              </Tooltip>
            ))}
          </ToggleGroup>
        ) : null}
        <StatusDot status={viewer.status} />
        <span className="shrink-0 text-xs font-medium">
          {viewer.status === "error" && viewer.detail
            ? viewer.detail
            : STATUS_LABELS[viewer.status]}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {[viewer.name, resolution].filter(Boolean).join(" · ")}
        </span>
        <ToolbarButton
          label={viewOnly ? "View only (click to control)" : "Controlling (click for view only)"}
          pressed={viewOnly}
          disabled={!connected}
          onClick={() => setViewOnly((value) => !value)}
        >
          {viewOnly ? <EyeOff /> : <Eye />}
        </ToolbarButton>
        <ToolbarButton
          label="Send Ctrl+Alt+Del"
          disabled={!connected || viewOnly}
          onClick={() => send({ type: "ctrl-alt-del" })}
        >
          <Keyboard />
        </ToolbarButton>
        <ToolbarButton label="Reconnect" onClick={newSession}>
          <RotateCw />
        </ToolbarButton>
        <ToolbarButton label="Pop out" disabled={freshAccess === null} onClick={popOut}>
          <PictureInPicture2 />
        </ToolbarButton>
      </div>
      <div className="bg-muted/40 relative min-h-0 flex-1">
        {props.visible && src ? (
          <iframe
            ref={frameRef}
            key={reloadCount}
            title={desktopNames[desktop] ?? "Server desktop"}
            src={src}
            className="absolute inset-0 size-full border-0 bg-transparent"
            style={{ colorScheme: resolvedTheme }}
            sandbox="allow-scripts allow-pointer-lock"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            // A new frame starts with defaults; bring it up to the panel's settings.
            onLoad={() => {
              send({ type: "theme", value: resolvedTheme });
              send({ type: "view-only", value: viewOnly });
            }}
          />
        ) : (
          <div className="text-muted-foreground absolute inset-0 grid place-items-center text-xs">
            Connecting…
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot(props: { readonly status: ViewerStatus }) {
  const busy = props.status === "connecting" || props.status === "reconnecting";
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      {busy ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          props.status === "connected" && "bg-emerald-500",
          busy && "bg-amber-400",
          (props.status === "disconnected" || props.status === "error") && "bg-red-500",
        )}
      />
    </span>
  );
}

function ToolbarButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            {...(props.pressed !== undefined ? { "aria-pressed": props.pressed } : {})}
            {...(props.disabled ? { disabled: true } : {})}
            className={cn("[&_svg]:size-3.5", props.pressed && "bg-accent text-accent-foreground")}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
