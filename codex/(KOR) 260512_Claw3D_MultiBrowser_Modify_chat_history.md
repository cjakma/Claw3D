# 260512 Claw3D Multi-Browser Modify Chat History

> 참고: 이 파일은 작업 스레드를 sanitized form으로 기록한 문서입니다. SSH private key path 같은 personal/local credential path는 repository 안에 저장되는 파일이므로 제거했습니다.

## Initial Context

repository instructions는 이 프로젝트를 OpenClaw용 Next.js 16 frontend인 Claw3D로 식별했다. 이 app은 upstream OpenClaw Gateway로 향하는 same-origin WebSocket proxy를 포함한 custom Node.js server(`server/index.js`)를 통해 실행된다.

중요한 repository constraints:

- OpenClaw runtime/source는 이 repository와 분리해 둔다.
- OpenClaw source code를 수정하지 않는다.
- 요청된 변경은 이 Claw3D app에 적용한다.
- 필요하면 protocol behavior를 이해하기 위해서만 OpenClaw source/runtime을 inspection한다.
- private, environment-specific, secret instructions를 commit하지 않는다.

## User Request 1: Multi-Browser Access 분석

사용자는 다음 정보를 제공했다.

- SSH protocol and host: `<WEB_SERVER_DOMAIN>`
- SSH user: `ubuntu`
- SSH key path: `[redacted local private key path]`
- Relevant remote directories: `/home/ubuntu`, `/home/ubuntu/claw3d`
- OpenClaw URL: `https://<WEB_SERVER_OPENCLAW_DOMAIN>/chat?session=agent%3Amain%3Amain`
- Claw3D URL: `https://<WEB_SERVER_CLAW3D_DOMAIN>/office`

사용자는 두 URL 모두 접속 가능하지만, Claw3D가 이미 인증을 완료한 단일 browser에서만 접근을 허용하는 것처럼 보인다고 설명했다. 동일 사용자가 여러 browser에서 Claw3D에 접근할 수 있도록 `/home/ubuntu/claw3d` 아래 code analysis를 요청했다. 추가 parameter는 최소화하기를 원했고, 가능하면 parameter 하나 정도를 선호했다. 또한 의도한 `params.device` shape를 제공했다.

```js
params: {
  device: {
    id: "...",          // public key fingerprint
    publicKey: "...",   // Ed25519 public key
    signature: "...",   // private key로 connect payload 서명
    signedAt: 123456,
    nonce: "..."        // gateway가 challenge를 보냈으면 포함
  }
}
```

## Assistant Analysis 1

assistant는 먼저 local workspace를 살펴본 뒤 remote `/home/ubuntu/claw3d`를 확인했다.

검토한 주요 local files:

- `src/lib/gateway/GatewayClient.ts`
- `src/lib/gateway/openclaw/GatewayBrowserClient.ts`
- `server/gateway-proxy.js`
- `server/access-gate.js`
- `tests/unit/gatewayProxy.test.ts`

주요 findings:

- Claw3D는 이미 browser client에서 `params.device`를 생성하고 있었다.
- browser device identity와 device token은 browser `localStorage`에 저장됐다.
- `server/access-gate.js`는 단순한 `studio_access` cookie를 사용했고, 그 자체로 single-browser access를 강제하지 않았다.
- `server/gateway-proxy.js`는 browser connect frames를 OpenClaw Gateway로 forward했고, browser가 auth/device material을 이미 제공하지 않은 경우에만 host token을 inject할 수 있었다.

assistant는 이어서 다음 OpenClaw runtime code를 inspection했다.

- `/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw/dist/...`

확인한 OpenClaw behavior:

- Gateway는 nonce와 함께 `connect.challenge`를 emit한다.
- Gateway는 `device.id`가 public key fingerprint와 일치해야 한다고 요구한다.
- Gateway는 `signedAt`, `nonce`, Ed25519 signature를 검증한다.
- Gateway는 해당 device가 `/home/ubuntu/.openclaw/devices` 아래 paired 상태인지 확인한다.
- 새 browser localStorage는 새 key pair를 의미하므로, 같은 human user라도 OpenClaw는 이를 새 device로 본다.

중요한 결론:

- 문제는 Claw3D HTTP access gate가 single-browser인 것이 아니었다.
- 문제는 OpenClaw Gateway device pairing이 browser-local이라는 점이었다.
- signature는 Gateway nonce와 current `signedAt`에 대해 매번 다시 계산해야 하므로, static `params.device` URL parameter로는 문제를 해결할 수 없었다.

## Assistant Recommendation 1

assistant는 세 가지 option을 제안했다.

1. `openclaw devices approve --latest`로 browser마다 별도 OpenClaw device를 승인한다.
2. `deviceImport=<encrypted one-time bundle>` 같은 URL parameter 하나를 사용해 승인된 browser identity/token을 다른 browser로 복사한다.
3. Claw3D server 자체가 Gateway device가 되도록 만든다.

Recommendation:

- Option 3 사용: Claw3D server가 OpenClaw Gateway device가 된다.
- Browser access는 Claw3D access gate가 관리한다.
- Upstream OpenClaw는 승인된 Claw3D server device 하나만 보게 된다.
- OpenClaw source code 변경은 필요 없다.

## User Request 2: Server Device Approach 작업량 추정

사용자는 option 3에 어느 정도 작업이 필요한지 질문했다.

## Assistant Analysis 2

assistant는 Claw3D에 server-side Gateway/device signing utilities가 이미 있는지 확인했다.

검토한 files:

- `package.json`
- `src/lib/gateway/nodeGatewayClient.ts`
- `server/index.js`

주요 findings:

- `@noble/ed25519`는 이미 dependency였다.
- `src/lib/gateway/nodeGatewayClient.ts`에는 server-side Ed25519 signing logic이 이미 있었지만, 매번 fresh identity를 생성하므로 persistent production proxy identity로 적합하지 않았다.
- proxy에는 persistent server device identity와 device token store가 필요했다.

## Assistant Estimate 2

예상 작업량:

- MVP: 반나절에서 하루.
- 안정화 버전: 1.5일에서 3일.

예상 변경:

- persistent server device auth module 추가.
- `server/gateway-proxy.js`에 `server-device` mode 확장.
- `CLAW3D_GATEWAY_AUTH_MODE=server-device` 같은 env parameter 하나 추가.
- tests 업데이트.
- Claw3D service 배포 및 재시작.

중요 caveat:

- OpenClaw는 auth token/device token을 signed payload에 포함하므로, browser가 sign한 뒤 proxy가 token만 inject할 수 없다. 따라서 Claw3D server가 upstream `connect` signature를 직접 수행해야 한다.

## User Request 3: OpenClaw 수정 없이 구현

사용자는 다음을 요청했다.

- OpenClaw source는 수정하지 않는다.
- Claw3D proxy/server authentication layer만 수정한다.
- remote `/home/ubuntu/claw3d`를 수정한 뒤, 동일 내용을 local `C:\env\workspace\260417_Claw3D_cjakma`에 적용한다.

## Assistant Implementation 3

assistant는 먼저 local에서 변경을 구현한 뒤 같은 파일을 remote로 복사했다.

Local changed files:

- `server/gateway-device-auth.js` added.
- `server/gateway-proxy.js` modified.
- `server/index.js` modified.
- `tests/unit/gatewayProxy.test.ts` modified.

Implementation summary:

- 새 persistent server-side Gateway device auth module을 추가했다.
- module은 Ed25519 server device identity를 생성하고 저장한다.
- module은 OpenClaw `connect.challenge` nonce payload에 서명한다.
- module은 발급된 OpenClaw `deviceToken`을 저장하고 재사용한다.
- proxy는 `CLAW3D_GATEWAY_AUTH_MODE=server-device`로 실행될 수 있다.
- server-device mode에서 browser connect frames는 upstream connect를 trigger하지만, upstream connect는 Claw3D server가 build하고 sign한다.
- `hello-ok` 반환 시 browser의 원래 connect response id를 유지한다.
- stored device token이 reject되면 proxy는 해당 token을 clear하고 shared upstream token으로 1회 fallback한다.

## Local Verification

첫 local test run은 `node_modules`가 없어서 실패했다.

```text
'vitest' is not recognized as an internal or external command
```

assistant는 다음을 실행했다.

```bash
npm ci
```

그 뒤 검증:

```bash
node -c server/gateway-device-auth.js
node -c server/gateway-proxy.js
node -c server/index.js
npm run test -- --run tests/unit/gatewayProxy.test.ts
```

Result:

```text
tests/unit/gatewayProxy.test.ts (12 tests) passed
```

## Remote Deployment

assistant는 다음 local files를 `/home/ubuntu/claw3d`로 복사했다.

- `server/gateway-device-auth.js`
- `server/gateway-proxy.js`
- `server/index.js`
- `tests/unit/gatewayProxy.test.ts`

이후 remote `.env`를 추가/업데이트했다.

```bash
CLAW3D_GATEWAY_AUTH_MODE=server-device
```

Remote verification:

```bash
cd /home/ubuntu/claw3d
node -c server/gateway-device-auth.js
node -c server/gateway-proxy.js
node -c server/index.js
npm run test -- --run tests/unit/gatewayProxy.test.ts
```

Result:

```text
tests/unit/gatewayProxy.test.ts (12 tests) passed
```

Remote service restart:

```bash
systemctl --user restart claw3d.service
systemctl --user is-active claw3d.service
```

Result:

```text
active
```

Service log confirmed:

```text
Gateway auth mode: server-device (state: /home/ubuntu/.openclaw/claw3d/gateway-device-auth.json)
```

server device state file이 생성됐다.

```text
/home/ubuntu/.openclaw/claw3d/gateway-device-auth.json
```

Permissions:

```text
rw-------
```

## Live Probe

assistant는 remote server에서 Claw3D local proxy endpoint를 통한 WebSocket probe를 실행했다.

Result:

```json
{"ok":true}
```

Logs:

```text
[gateway-device-auth] connect device=8bc0485c388d auth=shared-token
[gateway-device-auth] connect device=8bc0485c388d auth=device-token
```

의미:

- 첫 successful server-device connect는 upstream shared token을 사용했다.
- OpenClaw가 device token을 발급했다.
- 다음 connect는 stored server device token을 재사용했다.

## Final Assistant Response 3

assistant는 완료를 보고했다.

- OpenClaw source는 수정하지 않았다.
- Claw3D proxy/server auth layer를 변경했다.
- 동일 변경이 local과 remote에 반영됐다.
- remote service를 재시작했다.
- local 및 remote unit tests가 통과했다.
- Live WebSocket probe가 `{"ok":true}`를 반환했다.
- 새 browser는 Claw3D access gate를 통과하면 Claw3D에 접근할 수 있어야 하며, upstream OpenClaw는 approved Claw3D server device를 보게 된다.

## User Request 4: Save This Thread

사용자는 다음 파일 생성을 요청했다.

- `260512_Claw3D_MultiBrowser_Modify_chat_history.md`
- `260512_Claw3D_MultiBrowser_Modify.md`

두 파일 모두 다음 경로 아래:

```text
C:\env\workspace\260417_Claw3D_cjakma
```

사용자가 원한 내용:

- 첫 파일에는 chat contents 저장.
- 두 번째 파일에는 summary plus final change details 저장.

assistant는 이 sanitized chat history file과 companion summary/change document를 생성했다.
