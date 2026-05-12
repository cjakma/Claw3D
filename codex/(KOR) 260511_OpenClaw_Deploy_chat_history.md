# 2026-05-11 OpenClaw / Claw3D 배포 채팅 기록

> 참고: 이 파일은 배포 및 디버깅 스레드에서 오간 대화와 작업을 요약한 문서입니다.  
> 개인 키 경로, passphrase, access token, gateway token 같은 민감 값은 의도적으로 제거했습니다.

## 1. 초기 배포 요청

사용자는 SSH/server 정보를 제공하고 다음 작업을 요청했다.

- Ubuntu 서버에 SSH 접속.
- `/home/ubuntu` 아래 OpenClaw 동작 상태와 연결 URL 확인.
- `/home/ubuntu/claw3d` 아래 Claw3D 프로젝트 배포.
- 사용할 수 있는 OpenClaw Gateway URL과 Claw3D web URL 반환.

준수한 주요 repository 지침:

- OpenClaw source code는 수정하지 않는다.
- 변경은 Claw3D app 및 server/runtime 설정에만 적용한다.
- OpenClaw runtime checkout은 이 repo와 분리해 둔다.

## 2. 첫 SSH 시도와 Host Key 문제

첫 SSH 시도는 remote host key가 변경되어 실패했다.

관찰된 경고:

```text
WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!
Host key for pm-oci.duckdns.org has changed
```

SSH가 표시한 새 ED25519 fingerprint:

```text
SHA256:/U8wEYI0sIvT2uhUrap2TA/+qP3ZOCEcdNPEu7MoG9k
```

사용자의 일반 `known_hosts`를 수정하지 않기 위해 이 작업에는 workspace-local 임시 known hosts 파일을 사용했다.

## 3. SSH Key 암호화 확인

임시 host key를 수락한 뒤 SSH는 다음 오류로 실패했다.

```text
Permission denied (publickey)
```

확인 결과:

- PEM key 파일은 존재했다.
- key는 암호화되어 있었다.

```text
-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
```

이후 사용자가 `ssh-agent`를 시작하고 `ssh-add`로 key를 추가했으며, identity가 추가된 것을 확인했다.

## 4. 서버 상태 확인

SSH agent 설정 후 서버 접속에 성공했다.

`/home/ubuntu` 아래에서 확인된 항목:

- `.openclaw`
- `claw3d`
- `docker-compose`
- `docker-compose.yml`
- `openclaw-workspace`
- `portainer`

OpenClaw Gateway는 실행 중이었다.

```text
/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw/dist/index.js gateway --port 18789
```

당시 listen 상태는 loopback 전용이었다.

```text
127.0.0.1:18789
[::1]:18789
```

Claw3D 파일은 다음 경로에 있었다.

```text
/home/ubuntu/claw3d
```

하지만 Claw3D는 아직 `3000` 포트에서 listen 중이 아니었다.

## 5. Claw3D Remote Project 상태

`/home/ubuntu/claw3d`에서 확인한 내용:

- Node 사용 가능.
- dependencies는 이미 `node_modules`에 존재.
- `.env` 존재.
- `HOST=0.0.0.0`
- `PORT=3000`
- `CLAW3D_GATEWAY_URL=ws://localhost:18789`
- `STUDIO_ACCESS_TOKEN` 설정됨. 단, 채팅 기록에는 반복 기록하지 않음.

remote Git worktree에는 수정된 파일이 많았다. 따라서 `git pull`, reset, checkout은 수행하지 않았다.

결정:

- 서버에 존재하는 현재 project state를 그대로 배포한다.
- remote local 변경을 덮어쓰거나 되돌리지 않는다.

## 6. OpenClaw Gateway 기본 확인

서버에서 다음 WebSocket에 접속 테스트했다.

```text
ws://127.0.0.1:18789
```

성공 출력:

```text
ws_open
```

## 7. Claw3D Build

`/home/ubuntu/claw3d`에서 production build를 실행했다.

```bash
npm run build
```

Build는 성공했다.

Next.js는 optional `openclaw` package에 대해 warning을 출력했다.

```text
Module not found: Can't resolve 'openclaw'
```

repository 지침과 README 설명에 따라 이 warning은 예상된 것으로 처리했다.

## 8. Claw3D systemd Service

user systemd service를 생성했다.

```text
/home/ubuntu/.config/systemd/user/claw3d.service
```

실행 명령:

```text
/usr/bin/node /home/ubuntu/claw3d/server/index.js
```

Claw3D는 정상 시작됐다.

```text
claw3d.service - active (running)
```

listen 상태:

```text
0.0.0.0:3000
```

Studio token 없이 내부 확인 시 `401`이 반환됐고, 이를 통해 app 응답과 access gate 동작을 확인했다.

## 9. Nginx Proxy Manager와 Docker Network

확인된 Docker containers:

- `nginxproxymanager`
- `portainer`
- `watchtower`

NPM 바인딩 포트:

- `80`
- `81`
- `443`

Portainer 바인딩 포트:

- `9443`

존재하던 NPM proxy hosts:

- `pm-oci.duckdns.org`
- `portainer.pm-oci.duckdns.org`
- `openclaw.pm-oci.duckdns.org`
- `claw3d.pm-oci.duckdns.org`

사용자 확인 사항:

- `pm-oci.duckdns.org`는 계속 Nginx Proxy Manager를 가리켜야 한다.
- `openclaw.pm-oci.duckdns.org`는 직접 `:18789` 대신 사용한다.
- `claw3d.pm-oci.duckdns.org`는 직접 `:3000` 대신 사용한다.

root domain은 NPM으로 확인 및 복구했다.

```text
pm-oci.duckdns.org -> nginxproxymanager:81
```

## 10. Docker Host Gateway 조사

사용자는 `host.docker.internal` 또는 Docker host gateway 사용 여부를 질문했다.

확인 결과:

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

결론:

Docker host gateway를 사용한다.

```text
172.18.0.1
```

NPM upstream targets:

```text
openclaw.pm-oci.duckdns.org -> http://172.18.0.1:18789
claw3d.pm-oci.duckdns.org   -> http://172.18.0.1:3000
```

## 11. UFW와 Port 공개 논의

사용자는 UFW에서 `18789`를 열어야 하는지 질문했다.

결론:

- NPM over HTTPS/WSS를 사용한다면 `18789`를 public으로 열지 않는다.
- 외부에 필요한 포트는 다음으로 유지한다.

```text
22, 80, 81, 443
```

단, NPM container는 Docker bridge를 통해 Ubuntu native services에 접근할 수 있어야 한다.

NPM logs에 `499`와 upstream timeout behavior가 보였을 때의 테스트 결과:

```text
npm-admin nginxproxymanager:81 TCP OK
claw3d 172.18.0.1:3000 TCP TIMEOUT
openclaw 172.18.0.1:18789 TCP TIMEOUT
```

진단:

- NPM은 request를 받았다.
- NPM은 `172.18.0.1`로 전달을 시도했다.
- UFW가 Docker bridge traffic to host-native ports를 막고 있을 가능성이 높았다.

제안한 UFW rules:

```bash
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 3000 comment 'NPM to Claw3D'
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 18789 comment 'NPM to OpenClaw Gateway'
```

## 12. OpenClaw Gateway Bind Mode

OpenClaw Gateway는 처음에 다음 주소에서만 listen했다.

```text
127.0.0.1:18789
```

이 상태에서는 NPM이 다음 주소로 접근할 수 없었다.

```text
172.18.0.1:18789
```

OpenClaw service를 LAN bind mode로 변경했다.

```text
--bind lan
```

재시작 후 listen 상태:

```text
0.0.0.0:18789
```

다음 internal WebSocket test가 성공했다.

```text
ws://172.18.0.1:18789
```

출력:

```text
open
```

## 13. OpenClaw Control UI Origin Error

사용자는 다음 오류를 보고했다.

```text
origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)
```

관찰된 browser origin:

```text
https://openclaw.pm-oci.duckdns.org
```

기존 config에는 다음만 있었다.

```json
[
  "http://localhost:18789",
  "http://127.0.0.1:18789"
]
```

다음으로 업데이트했다.

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": [
        "http://localhost:18789",
        "http://127.0.0.1:18789",
        "https://openclaw.pm-oci.duckdns.org",
        "https://claw3d.pm-oci.duckdns.org"
      ]
    }
  }
}
```

Gateway를 재시작했다.

검증 결과 external Origin header로 WebSocket이 열렸다.

## 14. Device Pairing

allowed origins를 수정한 뒤 browser에는 다음이 표시됐다.

```text
device pairing required (requestId: 44510b2c-5036-4b4b-938c-b94d65670a24)
```

서버에서 요청을 승인했다.

```bash
openclaw devices approve 44510b2c-5036-4b4b-938c-b94d65670a24 --json
```

승인된 device:

- Platform: `Win32`
- Client: `openclaw-control-ui`
- Role: `operator`
- Scopes:
  - `operator.admin`
  - `operator.read`
  - `operator.write`
  - `operator.approvals`
  - `operator.pairing`

디버깅 중 별도 CLI pairing request도 생성됐다.

```text
ef9c0e76-000c-47f0-8bfa-e63fff416eec
```

이 request는 browser web access에 필요한 것이 아니라 CLI 관련으로 확인했다.

## 15. OpenClaw Update Error

사용자는 다음 오류를 보고했다.

```text
Update error: global-install-failed. The global package install did not verify on disk. Retry or reinstall from the CLI.
```

확인 결과:

- OpenClaw는 nvm 아래 설치되어 있었다.

```text
/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw
```

- 하지만 `npm prefix -g`는 다음으로 resolve됐다.

```text
/usr
```

이 때문에 update verification이 잘못된 global package tree를 보고 있었다.

적용한 수정:

- `NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0` 설정.
- OpenClaw service PATH에서 nvm bin이 먼저 오도록 보장.
- 수정된 environment로 update 실행.

사용한 update command:

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v24.15.0/bin:/usr/bin:/usr/local/bin:/bin
export NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0
openclaw update --yes --json
```

결과:

```text
OpenClaw 2026.5.6 -> 2026.5.7
```

업데이트가 성공했다.

## 16. Post-update Repair

업데이트 후 OpenClaw doctor가 systemd service와 config를 다시 생성했다.

Gateway가 다시 loopback으로 변경됐다.

```text
gateway.bind = loopback
```

그 결과 실제 `--bind lan` 동작이 제거됐다.

이로 인해 NPM-to-Gateway access가 다시 깨졌다.

다시 적용한 항목:

- `gateway.bind = lan`
- `ExecStart`에 `--bind lan` 포함
- `NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0`
- service에 nvm Node path 반영

최종 검증:

```text
OpenClaw 2026.5.7
Gateway listens on 0.0.0.0:18789
Claw3D listens on 0.0.0.0:3000
ws://172.18.0.1:18789 -> open
```

## 17. Summary File Created

사용자가 deployment summary file 생성을 요청했다.

생성된 파일:

```text
C:\env\workspace\260417_Claw3D_cjakma\260511_update.md
```

이 파일은 다음을 요약한다.

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
https://claw3d.pm-oci.duckdns.org
```

OpenClaw Gateway dashboard / Control UI:

```text
https://openclaw.pm-oci.duckdns.org
```

Gateway WebSocket URL:

```text
wss://openclaw.pm-oci.duckdns.org
```

Nginx Proxy Manager root:

```text
https://pm-oci.duckdns.org
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
node -e "const WebSocket=require('./node_modules/ws'); const ws=new WebSocket('ws://172.18.0.1:18789',{origin:'https://openclaw.pm-oci.duckdns.org'}); const t=setTimeout(()=>{console.log('timeout');process.exit(2)},5000); ws.on('open',()=>{console.log('open');clearTimeout(t);ws.close();process.exit(0)}); ws.on('error',e=>{console.log('error',e.message);clearTimeout(t);process.exit(1)});"
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

OpenClaw update 또는 doctor는 다음 파일을 다시 생성할 수 있다.

- `/home/ubuntu/.config/systemd/user/openclaw-gateway.service`
- `/home/ubuntu/.openclaw/openclaw.json`

향후 update 후에는 다음을 다시 확인한다.

- `gateway.bind`가 `lan`으로 유지되는지.
- `ExecStart`에 `--bind lan`이 포함되는지.
- `NPM_CONFIG_PREFIX`가 `/home/ubuntu/.nvm/versions/node/v24.15.0`를 가리키는지.
- Gateway가 `0.0.0.0:18789`에서 listen하는지.
