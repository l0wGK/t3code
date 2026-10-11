/**
 * Fork addition: the Desktop panel's pop-out. Viewer URLs opened from the
 * renderer get their own app window instead of the default browser, so the
 * server desktop can sit beside the chat or on another display.
 */
import type { BrowserWindowConstructorOptions } from "electron";

const DESKTOP_VIEWER_PATH = /^\/api\/desktop\/(?:open$|s\/[^/]+\/)/;

/** Whether `url` is a desktop viewer page (or the endpoint that redirects to one). */
export function isDesktopViewerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      DESKTOP_VIEWER_PATH.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** A plain, sandboxed window sized for the 1280×800 desktop plus a title bar. */
export const desktopViewerPopupOptions = (
  backgroundColor: string,
): BrowserWindowConstructorOptions => ({
  title: "Server desktop",
  width: 1280,
  height: 828,
  minWidth: 480,
  minHeight: 320,
  backgroundColor,
  autoHideMenuBar: true,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  },
});
