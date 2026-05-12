# 2026-05-11 OpenClaw / Claw3D Deployment and Connection Summary

## Server Access Information

- SSH host: `<WEB_SERVER_DOMAIN>`
- SSH user: `ubuntu`
- SSH port: `22`
- Claw3D project path: `/home/ubuntu/claw3d`
- OpenClaw config path: `/home/ubuntu/.openclaw/openclaw.json`
- Nginx Proxy Manager data path: `/home/ubuntu/docker-compose/data`

## Target Architecture

From the outside, only `22`, `80`, `81`, and `443` should be open. `18789` and `3000` should not be exposed directly.
However, UFW may contain rules for `22`, `80`, `81`, `443`, `3000`, and `18789`, while Oracle Cloud Infrastructure inbound network rules should exclude `3000` and `18789`.

```text
Windows/browser
  -> https://<WEB_SERVER_OPENCLAW_DOMAIN>
  -> Nginx Proxy Manager :443
  -> Docker host gateway 172.18.0.1:18789
  -> Ubuntu native OpenClaw Gateway

Windows/browser
  -> https://<WEB_SERVER_CLAW3D_DOMAIN>
  -> Nginx Proxy Manager :443
  -> Docker host gateway 172.18.0.1:3000
  -> Ubuntu native Claw3D
```

The base address `<WEB_SERVER_DOMAIN>` remains pointed at Nginx Proxy Manager.

## Docker Host Gateway Check

The Docker network used by the Nginx Proxy Manager container is `ocinetwork`.

- Docker network: `ocinetwork`
- Subnet: `172.18.0.0/16`
- Gateway: `172.18.0.1`
- NPM container IP: `172.18.0.3`
- Host bridge interface: `br-207f832643c5`
- Host bridge IP: `172.18.0.1/16`

In this Linux Docker environment, `host.docker.internal` did not resolve by default.

```text
host.docker.internal -> ENOTFOUND
Docker host gateway -> 172.18.0.1
```

Therefore, NPM upstreams should use `172.18.0.1`, not `host.docker.internal`.

## Nginx Proxy Manager Settings

Based on the NPM proxy host DB and generated conf files, the following settings were confirmed.

- `<WEB_SERVER_DOMAIN>`
  - upstream: `http://nginxproxymanager:81`
  - purpose: keep the Nginx Proxy Manager UI available
- `<WEB_SERVER_OPENCLAW_DOMAIN>`
  - upstream: `http://172.18.0.1:18789`
  - purpose: OpenClaw Gateway
- `<WEB_SERVER_CLAW3D_DOMAIN>`
  - upstream: `http://172.18.0.1:3000`
  - purpose: Claw3D web

The NPM access log confirmed that external requests reached NPM and were routed as `Sent-to 172.18.0.1`.

## UFW / Firewall

There is no need to expose `18789` or `3000` publicly.
UFW may contain rules for `22`, `80`, `81`, `443`, `3000`, and `18789`, while Oracle Cloud Infrastructure inbound network rules should exclude `3000` and `18789`.

What is required is allowing the NPM container to access the Ubuntu host gateway from inside the Docker bridge.

Current public port operating policy:

- allow: `22`, `80`, `81`, `443`
- do not expose publicly: `18789`, `3000`

If access from the NPM container to `172.18.0.1:3000` or `172.18.0.1:18789` times out, allow only the Docker bridge internal access like this.

```bash
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 3000 comment 'NPM to Claw3D'
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 18789 comment 'NPM to OpenClaw Gateway'
```

## Claw3D Deployment Status

The production build was run in `/home/ubuntu/claw3d`.

```bash
cd /home/ubuntu/claw3d
npm run build
```

The build succeeded. The `openclaw` package warning is an optional runtime warning documented in this repo and was not a build failure.

Claw3D was registered as a user systemd service.

- Unit: `/home/ubuntu/.config/systemd/user/claw3d.service`
- ExecStart: `/usr/bin/node /home/ubuntu/claw3d/server/index.js`
- Listen: `0.0.0.0:3000`
- Internal URL: `http://127.0.0.1:3000`
- NPM upstream URL: `http://172.18.0.1:3000`

Verification commands:

```bash
systemctl --user status claw3d.service
ss -ltnp | grep ':3000'
```

## OpenClaw Gateway Settings

The OpenClaw Gateway must run with LAN bind, not loopback-only bind, so that the NPM container can reach it.

Applied core settings:

- OpenClaw version: `2026.5.7`
- Gateway bind: `lan`
- Listen: `0.0.0.0:18789`
- Internal direct URL: `ws://127.0.0.1:18789`
- NPM upstream URL: `http://172.18.0.1:18789`
- External WebSocket URL: `wss://<WEB_SERVER_OPENCLAW_DOMAIN>`

The following value should be kept in `/home/ubuntu/.openclaw/openclaw.json`.

```json
{
  "gateway": {
    "bind": "lan",
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

The `origin not allowed` error was fixed by adding `https://<WEB_SERVER_OPENCLAW_DOMAIN>` to `allowedOrigins` and restarting the Gateway.

## OpenClaw systemd Unit Adjustment

During the OpenClaw update process, the systemd unit was regenerated, `--bind lan` disappeared, and the service returned to `loopback`. After the update, the following items were fixed again.

- Include `--bind lan` in `ExecStart`
- Pin Node path to the nvm Node installation
- Add `NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0`
- Prefer the nvm Node bin path in `PATH`

Current unit verification command:

```bash
systemctl --user show openclaw-gateway.service -p ExecStart -p Environment --no-pager
```

Expected current values:

```text
ExecStart=... /home/ubuntu/.nvm/versions/node/v24.15.0/bin/node ... openclaw/dist/index.js gateway --port 18789 --bind lan
NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0
```

## Device Pairing Handling

When the browser connected to the Gateway, the following error occurred.

```text
device pairing required (requestId: 44510b2c-5036-4b4b-938c-b94d65670a24)
```

The requestId was approved from the server.

```bash
openclaw devices approve 44510b2c-5036-4b4b-938c-b94d65670a24 --json
```

Approved browser device:

- Platform: `Win32`
- Client: `openclaw-control-ui`
- Role: `operator`
- Scopes:
  - `operator.admin`
  - `operator.read`
  - `operator.write`
  - `operator.approvals`
  - `operator.pairing`

A separate CLI request was generated during CLI approval testing.

```text
ef9c0e76-000c-47f0-8bfa-e63fff416eec
```

That request was for CLI access, not browser access, so it was not required for the web connection.

## OpenClaw Update Error Fix

Error observed:

```text
Update error: global-install-failed. The global package install did not verify on disk.
```

Cause:

- OpenClaw was installed under the nvm path.
- However, the service/update verification environment was looking at `/usr` as the npm global prefix.
- As a result, `npm list -g openclaw` could not find the actual install location.

Actual install location confirmed:

```text
/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw
```

Fix:

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v24.15.0/bin:/usr/bin:/usr/local/bin:/bin
export NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0
openclaw update --yes --json
```

Result:

```text
OpenClaw 2026.5.6 -> 2026.5.7
```

After the update, `gateway.bind` had returned to `loopback`, so it was restored to `lan`.

## Final Verified State

Final verified state:

- `claw3d.service`: active
- `openclaw-gateway.service`: active
- Claw3D listen: `0.0.0.0:3000`
- OpenClaw Gateway listen: `0.0.0.0:18789`
- Docker host gateway: `172.18.0.1`
- OpenClaw Gateway WebSocket direct test from server: success

Verification commands:

```bash
systemctl --user is-active claw3d.service openclaw-gateway.service
ss -ltnp | grep -E ':3000|:18789'
```

Internal WebSocket verification:

```bash
cd /home/ubuntu/claw3d
node -e "const WebSocket=require('./node_modules/ws'); const ws=new WebSocket('ws://172.18.0.1:18789',{origin:'https://<WEB_SERVER_OPENCLAW_DOMAIN>'}); const t=setTimeout(()=>{console.log('timeout');process.exit(2)},5000); ws.on('open',()=>{console.log('open');clearTimeout(t);ws.close();process.exit(0)}); ws.on('error',e=>{console.log('error',e.message);clearTimeout(t);process.exit(1)});"
```

Expected output:

```text
open
```

## URLs

Claw3D web:

```text
https://<WEB_SERVER_CLAW3D_DOMAIN>
```

OpenClaw Gateway dashboard / Control UI:

```text
https://<WEB_SERVER_OPENCLAW_DOMAIN>
```

Gateway URL used by Claw3D or WebSocket clients:

```text
wss://<WEB_SERVER_OPENCLAW_DOMAIN>
```

## Reference Log Commands

NPM OpenClaw proxy logs:

```bash
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-3_access.log
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-3_error.log
```

NPM Claw3D proxy logs:

```bash
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-4_access.log
sudo tail -f /home/ubuntu/docker-compose/data/logs/proxy-host-4_error.log
```

OpenClaw Gateway logs:

```bash
journalctl --user -u openclaw-gateway.service -f
```

Claw3D logs:

```bash
journalctl --user -u claw3d.service -f
```

## Cautions

- Running OpenClaw update or doctor may change the systemd unit and `gateway.bind` again.
- After updates, always re-check the following.

```bash
systemctl --user show openclaw-gateway.service -p ExecStart -p Environment --no-pager
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw/openclaw.json','utf8')); console.log(c.gateway.bind, c.gateway.controlUi)"
ss -ltnp | grep ':18789'
```

Expected values:

- `gateway.bind` is `lan`
- `ExecStart` includes `--bind lan`
- `NPM_CONFIG_PREFIX` points to `/home/ubuntu/.nvm/versions/node/v24.15.0`
- Gateway listens on `0.0.0.0:18789`
