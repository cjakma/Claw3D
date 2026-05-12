# 2026-05-11 OpenClaw / Claw3D 배포 및 연결 정리

## 서버 접속 정보

- SSH host: `pm-oci.duckdns.org`
- SSH user: `ubuntu`
- SSH port: `22`
- Claw3D project path: `/home/ubuntu/claw3d`
- OpenClaw config path: `/home/ubuntu/.openclaw/openclaw.json`
- Nginx Proxy Manager data path: `/home/ubuntu/docker-compose/data`

## 목표 구조

외부에서는 `22`, `80`, `81`, `443`만 열고, `18789`와 `3000`은 직접 공개하지 않는다.
다만, ufw 에는 22,80,81,443,3000,18789 를 모두 등록하고, 
Oracle Cloud Infrastructure 의 Network 항목 inbound 조건에서 3000 과 18789 를 배제한다.


```text
Windows/browser
  -> https://openclaw.pm-oci.duckdns.org
  -> Nginx Proxy Manager :443
  -> Docker host gateway 172.18.0.1:18789
  -> Ubuntu native OpenClaw Gateway

Windows/browser
  -> https://claw3d.pm-oci.duckdns.org
  -> Nginx Proxy Manager :443
  -> Docker host gateway 172.18.0.1:3000
  -> Ubuntu native Claw3D
```

기본 주소 `pm-oci.duckdns.org`는 계속 Nginx Proxy Manager를 바라보도록 유지했다.

## Docker host gateway 확인

Nginx Proxy Manager 컨테이너가 붙어 있는 Docker network는 `ocinetwork`이다.

- Docker network: `ocinetwork`
- Subnet: `172.18.0.0/16`
- Gateway: `172.18.0.1`
- NPM container IP: `172.18.0.3`
- Host bridge interface: `br-207f832643c5`
- Host bridge IP: `172.18.0.1/16`

Linux Docker 환경에서 `host.docker.internal`은 기본으로 resolve되지 않았다.

```text
host.docker.internal -> ENOTFOUND
Docker host gateway -> 172.18.0.1
```

따라서 NPM upstream에는 `host.docker.internal`이 아니라 `172.18.0.1`을 사용한다.

## Nginx Proxy Manager 설정

NPM proxy host DB 및 generated conf 기준으로 아래 설정이 확인되었다.

- `pm-oci.duckdns.org`
  - upstream: `http://nginxproxymanager:81`
  - 목적: Nginx Proxy Manager UI 유지
- `openclaw.pm-oci.duckdns.org`
  - upstream: `http://172.18.0.1:18789`
  - 목적: OpenClaw Gateway
- `claw3d.pm-oci.duckdns.org`
  - upstream: `http://172.18.0.1:3000`
  - 목적: Claw3D web

NPM access log에서 외부 요청이 NPM까지 들어오고 `Sent-to 172.18.0.1`로 라우팅되는 것을 확인했다.

## UFW / 방화벽

외부에 `18789`, `3000`을 열 필요는 없다.
ufw 에는 22,80,81,443,3000,18789 를 모두 등록하고, 
Oracle Cloud Infrastructure 의 Network 항목 inbound 조건에서 3000 과 18789 를 배제한다.

필요한 것은 NPM 컨테이너가 Docker bridge 내부에서 Ubuntu host gateway로 접근할 수 있게 허용하는 것이다.

현재 외부 공개 포트 운영 방향:

- allow: `22`, `80`, `81`, `443`
- do not expose publicly: `18789`, `3000`

NPM 컨테이너에서 `172.18.0.1:3000`, `172.18.0.1:18789` 접근이 timeout이면 아래처럼 Docker bridge 내부 접근만 허용한다.

```bash
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 3000 comment 'NPM to Claw3D'
sudo ufw allow in on br-207f832643c5 proto tcp from 172.18.0.0/16 to 172.18.0.1 port 18789 comment 'NPM to OpenClaw Gateway'
```

## Claw3D 배포 상태

`/home/ubuntu/claw3d`에서 production build를 실행했다.

```bash
cd /home/ubuntu/claw3d
npm run build
```

빌드는 성공했다. `openclaw` package 관련 warning은 이 repo 문서에 있는 optional runtime warning으로, 빌드 실패 요인은 아니었다.

Claw3D는 user systemd 서비스로 등록했다.

- Unit: `/home/ubuntu/.config/systemd/user/claw3d.service`
- ExecStart: `/usr/bin/node /home/ubuntu/claw3d/server/index.js`
- Listen: `0.0.0.0:3000`
- 내부 URL: `http://127.0.0.1:3000`
- NPM upstream URL: `http://172.18.0.1:3000`

확인 명령:

```bash
systemctl --user status claw3d.service
ss -ltnp | grep ':3000'
```

## OpenClaw Gateway 설정

OpenClaw Gateway는 NPM 컨테이너가 접근할 수 있도록 loopback 전용이 아니라 LAN bind로 실행해야 한다.

적용된 핵심 설정:

- OpenClaw version: `2026.5.7`
- Gateway bind: `lan`
- Listen: `0.0.0.0:18789`
- 내부 direct URL: `ws://127.0.0.1:18789`
- NPM upstream URL: `http://172.18.0.1:18789`
- 외부 WebSocket URL: `wss://openclaw.pm-oci.duckdns.org`

`/home/ubuntu/.openclaw/openclaw.json`에 아래 값이 유지되도록 했다.

```json
{
  "gateway": {
    "bind": "lan",
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

`origin not allowed` 에러는 위 `allowedOrigins`에 `https://openclaw.pm-oci.duckdns.org`를 추가하고 Gateway를 재시작해서 해결했다.

## OpenClaw systemd unit 조정

OpenClaw update 과정에서 systemd unit이 다시 생성되며 `--bind lan`이 빠지고 `loopback`으로 돌아간 적이 있었다. 업데이트 후 아래 항목을 다시 고정했다.

- `ExecStart`에 `--bind lan` 포함
- Node path를 nvm Node로 고정
- `NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0` 추가
- PATH에서 nvm Node bin을 우선 사용

현재 unit 확인 명령:

```bash
systemctl --user show openclaw-gateway.service -p ExecStart -p Environment --no-pager
```

현재 기대값:

```text
ExecStart=... /home/ubuntu/.nvm/versions/node/v24.15.0/bin/node ... openclaw/dist/index.js gateway --port 18789 --bind lan
NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0
```

## Device pairing 처리

브라우저에서 Gateway 연결 시 아래 에러가 발생했다.

```text
device pairing required (requestId: 44510b2c-5036-4b4b-938c-b94d65670a24)
```

서버에서 해당 requestId를 승인했다.

```bash
openclaw devices approve 44510b2c-5036-4b4b-938c-b94d65670a24 --json
```

승인된 브라우저 디바이스:

- Platform: `Win32`
- Client: `openclaw-control-ui`
- Role: `operator`
- Scopes:
  - `operator.admin`
  - `operator.read`
  - `operator.write`
  - `operator.approvals`
  - `operator.pairing`

중간에 CLI 승인 시도 때문에 별도 CLI request가 생성되었다.

```text
ef9c0e76-000c-47f0-8bfa-e63fff416eec
```

이 요청은 브라우저 접속용이 아니라 CLI용이므로 웹 연결에는 필수는 아니다.

## OpenClaw 업데이트 오류 해결

발생한 에러:

```text
Update error: global-install-failed. The global package install did not verify on disk.
```

원인:

- OpenClaw는 nvm 경로에 설치되어 있었다.
- 그러나 service/update 검증 환경의 npm global prefix가 `/usr`를 보고 있었다.
- 그 결과 `npm list -g openclaw` 검증이 실제 설치 위치를 찾지 못했다.

확인된 실제 설치 위치:

```text
/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw
```

수정:

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v24.15.0/bin:/usr/bin:/usr/local/bin:/bin
export NPM_CONFIG_PREFIX=/home/ubuntu/.nvm/versions/node/v24.15.0
openclaw update --yes --json
```

결과:

```text
OpenClaw 2026.5.6 -> 2026.5.7
```

업데이트 후 `gateway.bind`가 다시 `loopback`으로 돌아간 것을 확인하고 `lan`으로 복구했다.

## 최종 확인 상태

최종 확인된 상태:

- `claw3d.service`: active
- `openclaw-gateway.service`: active
- Claw3D listen: `0.0.0.0:3000`
- OpenClaw Gateway listen: `0.0.0.0:18789`
- Docker host gateway: `172.18.0.1`
- OpenClaw Gateway WebSocket direct test from server: 성공

확인 명령:

```bash
systemctl --user is-active claw3d.service openclaw-gateway.service
ss -ltnp | grep -E ':3000|:18789'
```

WebSocket 내부 확인:

```bash
cd /home/ubuntu/claw3d
node -e "const WebSocket=require('./node_modules/ws'); const ws=new WebSocket('ws://172.18.0.1:18789',{origin:'https://openclaw.pm-oci.duckdns.org'}); const t=setTimeout(()=>{console.log('timeout');process.exit(2)},5000); ws.on('open',()=>{console.log('open');clearTimeout(t);ws.close();process.exit(0)}); ws.on('error',e=>{console.log('error',e.message);clearTimeout(t);process.exit(1)});"
```

기대 출력:

```text
open
```

## 사용 URL

Claw3D web:

```text
https://claw3d.pm-oci.duckdns.org
```

OpenClaw Gateway dashboard / Control UI:

```text
https://openclaw.pm-oci.duckdns.org
```

Claw3D 또는 WebSocket 클라이언트에서 사용하는 Gateway URL:

```text
wss://openclaw.pm-oci.duckdns.org
```

## 참고 로그 명령

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

## 주의 사항

- OpenClaw update 또는 doctor 실행 후 systemd unit과 `gateway.bind`가 다시 바뀔 수 있다.
- 업데이트 후 반드시 아래를 재확인한다.

```bash
systemctl --user show openclaw-gateway.service -p ExecStart -p Environment --no-pager
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw/openclaw.json','utf8')); console.log(c.gateway.bind, c.gateway.controlUi)"
ss -ltnp | grep ':18789'
```

기대값:

- `gateway.bind` is `lan`
- `ExecStart` includes `--bind lan`
- `NPM_CONFIG_PREFIX` points to `/home/ubuntu/.nvm/versions/node/v24.15.0`
- Gateway listens on `0.0.0.0:18789`
