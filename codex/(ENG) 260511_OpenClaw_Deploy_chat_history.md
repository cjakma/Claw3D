# 2026-05-11 OpenClaw / Claw3D Deploy Chat History

> Note: This file summarizes the chat and actions from the deployment/debugging thread.  
> Sensitive values such as private key paths, passphrases, access tokens, and gateway tokens are intentionally redacted.

## 1. Initial Deployment Request

User provided SSH/server details and asked to:

- SSH into the Ubuntu server.
- Check OpenClaw functionality and connection URL under `/home/ubuntu`.
- Deploy the Claw3D project under `/home/ubuntu/claw3d`.
- Return the usable OpenClaw Gateway URL and Claw3D web URL.

Important repository instruction observed:

- Do not modify OpenClaw source code.
- Apply changes to the Claw3D app and server/runtime configuration only.
- Keep OpenClaw runtime checkout separate from this repo.

## 2. First SSH Attempt and Host Key Issue

The first SSH attempt failed because the remote host key had changed.

Observed warning:

```text
WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!
Host key for <WEB_SERVER_DOMAIN> has changed
```

The new ED25519 fingerprint shown by SSH was:

```text
SHA256:/U8wEYI0sIvT2uhUrap2TA/+qP3ZOCEcdNPEu7MoG9k
```

To avoid modifying the user's normal `known_hosts`, a temporary workspace-local known hosts file was used for this task.

## 3. SSH Key Was Encrypted

After accepting the temporary host key, SSH failed with:

```text
Permission denied (publickey)
```

Investigation showed:

- The PEM key file existed.
- The key was encrypted:

```text
-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
```

The user then started `ssh-agent`, added the key with `ssh-add`, and confirmed the identity was added.

## 4. Server Status Check

After SSH agent setup, server access succeeded.

Found under `/home/ubuntu`:

- `.openclaw`
- `claw3d`
- `docker-compose`
- `docker-compose.yml`
- `openclaw-workspace`
- `portainer`

OpenClaw Gateway was running:

```text
/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw/dist/index.js gateway --port 18789
```

At that time it listened only on loopback:

```text
127.0.0.1:18789
[::1]:18789
```

Claw3D files existed under:

```text
/home/ubuntu/claw3d
```

But Claw3D was not yet listening on port `3000`.

## 5. Claw3D Remote Project State

In `/home/ubuntu/claw3d`:

- Node was available.
- Dependencies already existed in `node_modules`.
- `.env` existed.
- `HOST=0.0.0.0`
- `PORT=3000`
- `CLAW3D_GATEWAY_URL=ws://localhost:18789`
- `STUDIO_ACCESS_TOKEN` was set, but not repeated in chat history.

The remote Git worktree showed many modified files. Because of that, no `git pull`, reset, or checkout was performed.

Decision:

- Deploy the existing server-side project state as-is.
- Avoid overwriting or reverting remote local changes.

## 6. OpenClaw Gateway Basic Check

From the server, a WebSocket connection to:

```text
ws://127.0.0.1:18789
```

was tested successfully.

Output:

```text
ws_open
```

## 7. Claw3D Build

In `/home/ubuntu/claw3d`, production build was run:

```bash
npm run build
```

Build succeeded.

Next.js produced warnings about the optional `openclaw` package:

```text
Module not found: Can't resolve 'openclaw'
```

This was treated as expected based on the repository instructions and README notes.

## 8. Claw3D systemd Service

A user systemd service was created:

```text
/home/ubuntu/.config/systemd/user/claw3d.service
```

It runs:

```text
/usr/bin/node /home/ubuntu/claw3d/server/index.js
```

Claw3D started successfully:

```text
claw3d.service - active (running)
```

It listened on:

```text
0.0.0.0:3000
```

Internal check without Studio token returned `401`, which confirmed the app was responding and access gate was active.

## 9. Nginx Proxy Manager and Docker Network

Docker containers found:

- `nginxproxymanager`
- `portainer`
- `watchtower`

NPM was bound to:

- `80`
- `81`
- `443`

Portainer was bound to:

- `9443`

NPM proxy hosts existed for:

- `<WEB_SERVER_DOMAIN>`
- `portainer.<WEB_SERVER_DOMAIN>`
- `<WEB_SERVER_OPENCLAW_DOMAIN>`
- `<WEB_SERVER_CLAW3D_DOMAIN>`

The user clarified:

- `<WEB_SERVER_DOMAIN>` should continue pointing to Nginx Proxy Manager.
- `<WEB_SERVER_OPENCLAW_DOMAIN>` should replace direct `:18789`.
- `<WEB_SERVER_CLAW3D_DOMAIN>` should replace direct `:3000`.

The root domain was confirmed/restored to NPM:

```text
<WEB_SERVER_DOMAIN> -> nginxproxymanager:81
```

## 10. Docker Host Gateway Investigation

User asked whether to use `host.docker.internal` or Docker host gateway.

Checks showed:

```text
host.docker.internal -> ENOTFOUND
```

Docker network:

```text
ocinetwork
Subnet: 172.18.0.0/16
Gateway: 172.18.0.1
NPM container IP: 172.18.0.3
Host bridge interface: br-207f832643c5
```

Conclusion:

Use Docker host gateway:

```text
172.18.0.1
```

NPM upstream targets:

```text
<WEB_SERVER_OPENCLAW_DOMAIN> -> http://172.18.0.1:18789
<WEB_SERVER_CLAW3D_DOMAIN>   -> http://172.18.0.1:3000
```

## 11. UFW and Port Exposure Discussion

User asked whether `18789` must be opened in UFW.

Conclusion:

- Do not open `18789` publicly if using NPM over HTTPS/WSS.
- External required ports remain:

```text
22, 80, 81, 443
```

However, NPM container must be able to reach Ubuntu native services via Docker bridge.

When NPM logs showed `499` and upstream timeout behavior, tests showed:

```text
npm-admin nginxproxymanager:81 TCP OK
claw3d 172.18.0.1:3000 TCP TIMEOUT
openclaw 172.18.0.1:18789 TCP TIMEOUT
```

Diagnosis:

- NPM received the request.
- NPM tried to send to `172.18.0.1`.
- UFW likely blocked Docker bridge traffic to host-native ports.

Suggested UFW rules:

```bash
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 3000 comment 'NPM to Claw3D'
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 18789 comment 'NPM to OpenClaw Gateway'
```

## 12. OpenClaw Gateway Bind Mode

OpenClaw Gateway initially listened only on:

```text
127.0.0.1:18789
```

That prevented NPM from reaching it through:

```text
172.18.0.1:18789
```

OpenClaw service was changed to bind in LAN mode:

```text
--bind lan
```

After restart, it listened on:

```text
0.0.0.0:18789
```

Internal WebSocket test to:

```text
ws://172.18.0.1:18789
```

returned:

```text
open
```

## 13. OpenClaw Control UI Origin Error

User reported the error:

```text
origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)
```

Observed browser origin:

```text
https://<WEB_SERVER_OPENCLAW_DOMAIN>
```

Current config had only:

```json
[
  "http://localhost:18789",
  "http://127.0.0.1:18789"
]
```

Updated:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": [
        "http://localhost:18789",
        "http://127.0.0.1:18789",
        "https://<WEB_SERVER_OPENCLAW_DOMAIN>",
        "https://<WEB_SERVER_CLAW3D_DOMAIN>"
      ]
    }
  }
}
```

Gateway was restarted.

Verification showed WebSocket opened with the external Origin header.

## 14. Device Pairing

After fixing allowed origins, browser showed:

```text
device pairing required (requestId: 44510b2c-5036-4b4b-938c-b94d65670a24)
```

The request was approved from the server:

```bash
openclaw devices approve 44510b2c-5036-4b4b-938c-b94d65670a24 --json
```

Approved device:

- Platform: `Win32`
- Client: `openclaw-control-ui`
- Role: `operator`
- Scopes:
  - `operator.admin`
  - `operator.read`
  - `operator.write`
  - `operator.approvals`
  - `operator.pairing`

A separate CLI pairing request was also generated during debugging:

```text
ef9c0e76-000c-47f0-8bfa-e63fff416eec
```

That request was identified as CLI-related, not required for browser web access.

## 15. OpenClaw Update Error

User reported:

```text
Update error: global-install-failed. The global package install did not verify on disk. Retry or reinstall from the CLI.
```

Investigation showed:

- OpenClaw was installed under nvm:

```text
/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw
```

- But `npm prefix -g` was resolving to:

```text
/usr
```

This caused update verification to look in the wrong global package tree.

Fix applied:

- Set `NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0`.
- Ensure OpenClaw service PATH includes nvm bin first.
- Run update with the corrected environment.

Update command used:

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v24.15.0/bin:/usr/bin:/usr/local/bin:/bin
export NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0
openclaw update --yes --json
```

Result:

```text
OpenClaw 2026.5.6 -> 2026.5.7
```

Update completed successfully.

## 16. Post-update Repair

After update, OpenClaw doctor regenerated the systemd service and config.

It changed Gateway back to loopback:

```text
gateway.bind = loopback
```

and removed the effective `--bind lan` behavior.

This broke NPM-to-Gateway access again.

Reapplied:

- `gateway.bind = lan`
- `ExecStart` includes `--bind lan`
- `NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0`
- nvm Node path in service

Final verification:

```text
OpenClaw 2026.5.7
Gateway listens on 0.0.0.0:18789
Claw3D listens on 0.0.0.0:3000
ws://172.18.0.1:18789 -> open
```

## 17. Summary File Created

User requested a deployment summary file.

Created:

```text
C:\env\workspace\260417_Claw3D_cjakma\260511_update.md
```

The file summarizes:

- NPM structure
- Docker host gateway
- UFW guidance
- Claw3D deployment
- OpenClaw bind mode
- `allowedOrigins`
- device pairing
- update error and fix
- final verification commands

## 18. Current Important URLs

Claw3D web:

```text
https://<WEB_SERVER_CLAW3D_DOMAIN>
```

OpenClaw Gateway dashboard / Control UI:

```text
https://<WEB_SERVER_OPENCLAW_DOMAIN>
```

Gateway WebSocket URL:

```text
wss://<WEB_SERVER_OPENCLAW_DOMAIN>
```

Nginx Proxy Manager root remains:

```text
https://<WEB_SERVER_DOMAIN>
```

## 19. Useful Verification Commands

Service status:

```bash
systemctl --user is-active claw3d.service openclaw-gateway.service
```

Listening ports:

```bash
ss -ltnp | grep -E ':3000|:18789'
```

OpenClaw service unit:

```bash
systemctl --user show openclaw-gateway.service -p ExecStart -p Environment --no-pager
```

OpenClaw config check:

```bash
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw/openclaw.json','utf8')); console.log(c.gateway.bind, c.gateway.controlUi)"
```

OpenClaw WebSocket check:

```bash
cd /home/ubuntu/claw3d
node -e "const WebSocket=require('./node_modules/ws'); const ws=new WebSocket('ws://172.18.0.1:18789',{origin:'https://<WEB_SERVER_OPENCLAW_DOMAIN>'}); const t=setTimeout(()=>{console.log('timeout');process.exit(2)},5000); ws.on('open',()=>{console.log('open');clearTimeout(t);ws.close();process.exit(0)}); ws.on('error',e=>{console.log('error',e.message);clearTimeout(t);process.exit(1)});"
```

NPM OpenClaw logs:

```bash
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-3_access.log
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-3_error.log
```

NPM Claw3D logs:

```bash
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-4_access.log
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-4_error.log
```

Gateway logs:

```bash
journalctl --user -u openclaw-gateway.service -f
```

Claw3D logs:

```bash
journalctl --user -u claw3d.service -f
```

## 20. Ongoing Caution

OpenClaw update or doctor may regenerate:

- `/home/ubuntu/.config/systemd/user/openclaw-gateway.service`
- `/home/ubuntu/.openclaw/openclaw.json`

After future updates, re-check:

- `gateway.bind` remains `lan`.
- `ExecStart` includes `--bind lan`.
- `NPM_CONFIG_PREFIX` points to `/home/ubuntu/.nvm/versions/node/v24.15.0`.
- Gateway listens on `0.0.0.0:18789`.
