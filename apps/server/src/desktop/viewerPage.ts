/**
 * Fork addition: the Desktop panel's viewer page. It replaces noVNC's stock
 * pages with a full-bleed canvas built on noVNC's RFB core, which is loaded
 * relative to the session path. Status and controls live in the panel's
 * toolbar; the page reports status and accepts commands over postMessage.
 *
 * Protocol (both directions carry `source`):
 *   page → parent  { source: "t3-desktop-viewer", type: "status", status, detail?, name?, width?, height? }
 *                  { source: "t3-desktop-viewer", type: "request-session" }   // session expired
 *   parent → page  { source: "t3-desktop-panel", type: "theme", value: "light" | "dark" }
 *                  { source: "t3-desktop-panel", type: "reconnect" | "ctrl-alt-del" | "focus" }
 *                  { source: "t3-desktop-panel", type: "view-only", value: boolean }
 */
export const DESKTOP_VIEWER_PAGE = "/t3-viewer.html";

export const desktopViewerHtml = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Server desktop</title>
<style>
  :root {
    color-scheme: dark;
    --fg: #e7e7ea; --muted: #9a9aa3; --card: rgba(24, 24, 27, 0.86); --border: rgba(255, 255, 255, 0.08);
    --accent: #3b82f6; --shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --fg: #18181b; --muted: #6b6b75; --card: rgba(255, 255, 255, 0.9); --border: rgba(0, 0, 0, 0.08);
    --shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif; color: var(--fg); }
  #screen { position: absolute; inset: 10px; }
  #screen canvas { border-radius: 10px; box-shadow: var(--shadow); outline: none; }
  #overlay { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
    transition: opacity 160ms ease; }
  #overlay[hidden] { display: grid; opacity: 0; }
  #overlay[hidden] .card { pointer-events: none; }
  .card { pointer-events: auto; display: flex; flex-direction: column; align-items: center; gap: 10px;
    padding: 18px 22px; border-radius: 14px; background: var(--card); border: 1px solid var(--border);
    box-shadow: var(--shadow); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); max-width: 280px;
    text-align: center; }
  .title { font-weight: 600; }
  .detail { color: var(--muted); font-size: 12px; }
  .spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border);
    border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
  .spinner[hidden], button[hidden] { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  button { font: inherit; font-weight: 500; color: #fff; background: var(--accent); border: 0; border-radius: 8px;
    padding: 6px 14px; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
</style>
</head>
<body>
<div id="screen"></div>
<div id="overlay">
  <div class="card">
    <div class="spinner" id="spinner"></div>
    <div class="title" id="title">Connecting to desktop…</div>
    <div class="detail" id="detail"></div>
    <button id="retry" hidden>Reconnect</button>
  </div>
</div>
<script type="module">
  import RFB from "./core/rfb.js";

  const params = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.replace(/^#&?/, ""));
  const password = fragment.get("password") ?? undefined;
  const path = params.get("path") ?? "websockify";
  const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/" + path;
  const embedded = window.parent !== window;

  const el = (id) => document.getElementById(id);
  const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
  let rfb = null;
  let attempt = 0;
  let viewOnly = false;
  let retryTimer = null;

  function post(message) {
    if (embedded) window.parent.postMessage({ source: "t3-desktop-viewer", ...message }, "*");
  }

  function setTheme(value) {
    document.documentElement.dataset.theme = value === "light" ? "light" : "dark";
  }
  setTheme(params.get("theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));

  function show(state) {
    el("overlay").hidden = state === null;
    if (state === null) return;
    el("title").textContent = state.title;
    el("detail").textContent = state.detail ?? "";
    el("spinner").hidden = !state.busy;
    el("retry").hidden = state.busy;
  }

  function status(statusValue, extra = {}) {
    post({ type: "status", status: statusValue, ...extra });
  }

  function connect() {
    clearTimeout(retryTimer);
    if (rfb) { try { rfb.disconnect(); } catch {} rfb = null; }
    el("screen").replaceChildren();
    show({ title: attempt === 0 ? "Connecting to desktop…" : "Reconnecting…", busy: true });
    status(attempt === 0 ? "connecting" : "reconnecting");
    const client = new RFB(el("screen"), wsUrl, { credentials: password ? { password } : {} });
    rfb = client;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.clipViewport = false;
    client.background = "transparent";
    client.showDotCursor = true;
    client.focusOnClick = true;
    client.qualityLevel = 7;
    client.compressionLevel = 2;
    client.viewOnly = viewOnly;
    client.addEventListener("connect", () => {
      if (rfb !== client) return;
      attempt = 0;
      show(null);
      const canvas = el("screen").querySelector("canvas");
      status("connected", { width: canvas?.width, height: canvas?.height });
      client.focus();
    });
    client.addEventListener("desktopname", (event) => {
      if (rfb === client) status("connected", { name: event.detail.name });
    });
    client.addEventListener("credentialsrequired", () => {
      show({ title: "Password required", detail: "The desktop's VNC password is missing from the server config.", busy: false });
      status("error", { detail: "VNC password required" });
    });
    client.addEventListener("securityfailure", (event) => {
      show({ title: "Couldn't sign in to the desktop", detail: event.detail.reason || "Check the VNC password in desktop.json.", busy: false });
      status("error", { detail: "VNC authentication failed" });
    });
    client.addEventListener("disconnect", (event) => {
      if (rfb !== client) return;
      rfb = null;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt++];
        show({ title: "Reconnecting…", detail: event.detail.clean ? "The desktop closed the connection." : "Lost connection to the desktop.", busy: true });
        status("reconnecting");
        retryTimer = setTimeout(connect, delay);
        return;
      }
      // Repeated failures usually mean the session URL expired or the viewer stopped.
      show({ title: "Disconnected", detail: "The desktop isn't reachable right now.", busy: false });
      status("disconnected");
      if (embedded) post({ type: "request-session" });
    });
  }

  el("retry").addEventListener("click", () => {
    attempt = 0;
    if (embedded) post({ type: "request-session" });
    else connect();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== "t3-desktop-panel") return;
    switch (data.type) {
      case "theme": setTheme(data.value); break;
      case "reconnect": attempt = 0; connect(); break;
      case "ctrl-alt-del": rfb?.sendCtrlAltDel(); rfb?.focus(); break;
      case "focus": rfb?.focus(); break;
      case "view-only":
        viewOnly = Boolean(data.value);
        if (rfb) rfb.viewOnly = viewOnly;
        break;
    }
  });

  connect();
</script>
</body>
</html>
`;
