# Host setup (fork addition)

Files that run this fork on its Linux host, kept here so the setup can be rebuilt.

| File                                                       | Installed at              | Purpose                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-service.sh`                                       | `~/desktop-service.sh`    | Runs the GUI desktop: TigerVNC `Xvnc :1`, fluxbox, tint2, websockify (noVNC on :6080), Firefox. Each part is restarted if it exits.                                                                           |
| `systemd/t3-desktop.service`                               | `~/.config/systemd/user/` | Runs the desktop independently of the T3 Code server, so server restarts don't stop it.                                                                                                                       |
| `desktop.sh`                                               | `~/desktop.sh`            | For agents: starts the desktop if needed and opens a URL in its Firefox.                                                                                                                                      |
| `tint2rc`                                                  | `~/.config/tint2/tint2rc` | The taskbar.                                                                                                                                                                                                  |
| `fluxbox/apps`, `fluxbox/overlay`, `fluxbox/init-settings` | `~/.fluxbox/`             | Firefox maximized without a window-manager title bar; dark style; gradient wallpaper. Merge `init-settings` into `~/.fluxbox/init`.                                                                           |
| `build-server-runtime.sh`                                  | anywhere                  | Builds a server runtime archive: `build-server-runtime.sh 0.0.45+l0wgk.N`. Needs Node 26.8.2 at `~/.local/share/node-v26.8.2`.                                                                                |
| `switch-runtime.sh`                                        | `~/.t3/runtime/`          | Switches the service to an installed runtime, health-checks it, and rolls back if it fails. Run it via `systemd-run --user --on-active=120s …`, because restarting the server stops agents running inside it. |

## First-time setup

```sh
sudo apt-get install -y tigervnc-standalone-server tigervnc-tools novnc websockify fluxbox tint2 firefox xdotool scrot xclip wmctrl
vncpasswd ~/.vnc/passwd            # the password goes in <stateDir>/desktop.json as vncPassword
cp desktop-service.sh desktop.sh ~/ && cp tint2rc ~/.config/tint2/
cp systemd/t3-desktop.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now t3-desktop.service
```

Firefox prefs used on the desktop (`user.js` in its profile): `browser.tabs.inTitlebar = 1`,
`browser.sessionstore.resume_from_crash = false`, and on hosts without working IPv6
`network.dns.disableIPv6 = true`.

## Deploying a server change

```sh
scripts/fork/host/build-server-runtime.sh 0.0.45+l0wgk.N
tar -xzf /tmp/release-cli/t3-0.0.45+l0wgk.N-linux-x64.tar.gz -C /tmp/rt && \
  mv /tmp/rt/t3-* ~/.t3/runtime/versions/0.0.45+l0wgk.N && \
  echo 0.0.45+l0wgk.N > ~/.t3/runtime/versions/0.0.45+l0wgk.N/.install-complete
systemd-run --user --on-active=120s ~/.t3/runtime/switch-runtime.sh 0.0.45+l0wgk.N <current version>
```
