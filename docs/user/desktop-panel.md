# Desktop panel (fork addition)

Watch and control the server machine's graphical desktop beside a thread, for example to
log in to a website for an agent or take over a browser it is driving. Open it from the
right panel's **+** menu or launcher (**Desktop**, shortcut K).

The panel shows a [noVNC](https://novnc.com) viewer through the T3 server, so it works the same
over LAN, Tailscale, and T3 Connect. The VNC server itself stays on loopback. Opening the
panel needs operate access to the environment; the server then issues a viewer session
that lasts eight hours. Choose **Reconnect** after a disconnect or an expired session.

## Setup

Run a VNC server for the desktop and `websockify` serving noVNC on loopback, for example:

```sh
x11vnc -display :1 -localhost -rfbport 5901 -forever -shared -rfbauth ~/.vnc/passwd -bg
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901
```

Then create `desktop.json` in the server's data directory (`~/.t3/userdata/desktop.json`):

```json
{
  "upstream": "http://127.0.0.1:6080",
  "vncPassword": "your-vnc-password"
}
```

`upstream` defaults to `http://127.0.0.1:6080`. The password is handed to the viewer in the
URL fragment, which is never sent to a server. The file is read on every request.
