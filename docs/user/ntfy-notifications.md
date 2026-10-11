# ntfy notifications (fork addition)

Get a push notification on any device with the [ntfy](https://ntfy.sh) app when an agent
finishes, fails, needs approval, or waits for input. Unlike Device Notifications, this needs
no T3 Connect link and works with a custom build of the server.

1. Install ntfy on your phone or computer and subscribe to a topic. Topics on ntfy.sh are
   public to anyone who knows the name, so pick a long random one.
2. Create `ntfy.json` in the server's data directory (`~/.t3/userdata/ntfy.json` by default):

   ```json
   {
     "topic": "my-long-random-topic"
   }
   ```

Optional fields: `server` (a self-hosted ntfy URL, default `https://ntfy.sh`), `token`
(an access token for protected topics), `click` (the link opened when you tap the
notification; `{deepLink}` becomes `/threads/<environment>/<thread>`, default
`t3code:/{deepLink}` to open the thread in the T3 Code app, `""` for no link), and
`enabled` (`false` pauses alerts).

The file is read on every alert, so changes apply without restarting the server.
Each thread alerts once per finish, failure, approval, or question, after the state has
held for three seconds; threads that were already waiting when the server started stay quiet.
