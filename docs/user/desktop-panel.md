# Desktop panel (fork addition)

Watch and control the server machine's graphical desktop beside a thread, for example to
log in to a website for an agent or take over a browser it is driving. Open it from the
right panel's **+** menu or launcher (**Desktop**, shortcut K).

The panel shows a [noVNC](https://novnc.com) viewer through the T3 server, so it works the same
over LAN, Tailscale, and T3 Connect. The VNC server itself stays on loopback. Opening the
panel needs operate access to the environment; the server then issues a viewer session
that lasts eight hours. Choose **Reconnect** after a disconnect or an expired session.

**Pop out** opens the viewer in its own window. **Cmd+V** (Ctrl+V off macOS) pastes your
clipboard into the desktop, and text you copy there with Cmd/Ctrl+C or X comes back to your
clipboard. On a Mac, other Cmd shortcuts are sent to the desktop as their Ctrl equivalents.

## Setup

Run a VNC server for the desktop and `websockify` serving noVNC on loopback. TigerVNC's
`Xvnc` is recommended: it syncs the clipboard as UTF-8, while x11vnc only handles Latin-1.

```sh
Xvnc :1 -geometry 1280x800 -rfbport 5901 -localhost yes -SecurityTypes VncAuth \
  -PasswordFile ~/.vnc/passwd -AlwaysShared -SendPrimary=0 &
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
