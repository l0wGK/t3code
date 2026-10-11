import type { EnvironmentId } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { ExternalLink, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";

/**
 * The URL that opens a desktop viewer session. The server checks the media
 * ticket (or cookie) and redirects to a signed session URL; see
 * apps/server/src/desktop/DesktopViewerProxy.ts.
 */
export function desktopOpenUrl(access: DeviceHubAccess): string {
  const url = new URL(access.httpBase.replace(/\/api\/device-hub\/?$/, "/api/desktop/open"));
  const ticket = access.query.wsTicket;
  if (ticket) url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

/**
 * Fork addition: the server machine's GUI desktop in a noVNC frame. The frame is
 * sandboxed without same-origin access, so the viewer cannot reach this app.
 */
export function DesktopPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
}) {
  const access = useDeviceHubAccess(props.environmentId);
  // Access cached before this panel mounted may hold an expired ticket, so the
  // frame waits for a fresh one. A missing value is already being minted.
  const staleAccessRef = useRef(access);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (staleAccessRef.current !== null) refreshDeviceHubAccess(props.environmentId);
  }, [props.environmentId, reloadCount]);

  const freshAccess = access !== null && access !== staleAccessRef.current ? access : null;
  const src = freshAccess ? desktopOpenUrl(freshAccess) : null;

  const reconnect = () => {
    staleAccessRef.current = access;
    setReloadCount((count) => count + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          Server desktop
        </span>
        <Button size="xs" variant="ghost" onClick={reconnect} aria-label="Reconnect">
          <RotateCw className="size-3" />
          Reconnect
        </Button>
        {src ? (
          <Button
            size="xs"
            variant="ghost"
            render={<a href={src} target="_blank" rel="noreferrer" />}
            aria-label="Open in a new window"
            onClick={() => {
              // The link's ticket is single-session; mint the next one now.
              reconnect();
            }}
          >
            <ExternalLink className="size-3" />
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        {props.visible && src ? (
          <iframe
            key={reloadCount}
            title="Server desktop"
            src={src}
            className="absolute inset-0 size-full border-0"
            sandbox="allow-scripts allow-pointer-lock"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
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
