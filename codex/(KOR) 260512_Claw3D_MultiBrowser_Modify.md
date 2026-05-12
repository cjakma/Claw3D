# 260512 Claw3D Multi-Browser Modify

## Summary

처음에는 Claw3D가 인증된 브라우저 하나만 OpenClaw에 연결하도록 제한하는 것처럼 보였다. 조사 결과 제한 요인은 Claw3D의 HTTP access gate가 아니었다. 실제 문제는 OpenClaw Gateway device pairing이었다. 각 브라우저가 `localStorage`에 자체 Ed25519 device identity를 생성하고 저장하므로, 새 브라우저는 OpenClaw 입장에서 완전히 새로운 unpaired device로 보였다.

선택한 해결책은 Claw3D server 자체가 OpenClaw Gateway device로 동작하도록 만드는 것이었다. 이 방식에서는 browser가 기존처럼 Claw3D에 인증하고, upstream OpenClaw는 하나의 persistent Claw3D server device만 보게 된다. 이 접근은 OpenClaw source code를 수정하지 않으며, browser private key나 device token을 브라우저 간 복사하지 않아도 된다.

## Key Findings

- Claw3D의 `server/access-gate.js`는 `studio_access` cookie를 사용하며, 본질적으로 single-browser 접근 제한을 걸지 않는다.
- `src/lib/gateway/openclaw/GatewayBrowserClient.ts`의 browser-side Gateway auth는 device identity와 device token을 browser `localStorage`에 저장한다.
- OpenClaw는 `device.id`, `publicKey`, `signature`, `signedAt`, Gateway nonce를 검증한다.
- 새 브라우저는 새 public key fingerprint를 의미하며, OpenClaw는 이를 pairing이 필요한 새 device로 처리한다.
- signature는 connection nonce마다 생성되어야 하므로, single static `params.device` parameter만으로는 충분하지 않다.
- browser signing 후 gateway token을 주입하는 방식은 안전하지 않거나 유효하지 않다. OpenClaw가 signed payload에 auth token/device token을 포함하기 때문이다.

## Implemented Solution

`CLAW3D_GATEWAY_AUTH_MODE=server-device`를 구현했다.

이 mode에서:

- Browser는 기존처럼 Claw3D의 same-origin WebSocket proxy에 연결한다.
- Claw3D server가 upstream OpenClaw Gateway WebSocket을 연다.
- Claw3D server가 upstream `connect.challenge`를 소비한다.
- Claw3D server가 persistent Ed25519 server device identity로 upstream `connect` payload에 서명한다.
- OpenClaw가 Claw3D server device에 `deviceToken`을 발급한다.
- Claw3D가 해당 token을 저장하고 이후 connection에서 재사용한다.
- Browser connect response id는 유지되므로 frontend connection flow가 계속 동작한다.

## Files Changed

### Added

- `server/gateway-device-auth.js`
  - Persistent Claw3D server device identity.
  - Ed25519 key generation and fingerprint derivation.
  - OpenClaw v2 device-auth payload signing.
  - Device token storage and reuse.
  - Runtime 저장 위치:

```text
/home/ubuntu/.openclaw/claw3d/gateway-device-auth.json
```

### Modified

- `server/gateway-proxy.js`
  - `gatewayAuthMode`와 `serverDeviceAuth` options 추가.
  - server-device upstream connect flow 추가.
  - server-device mode에서 upstream `connect.challenge` 소비.
  - server-signed `params.device`로 upstream connect frames 구성.
  - upstream connect response를 browser의 원래 connect request id로 mapping.
  - 발급된 `deviceToken` 저장.
  - 거부된 stored device token을 삭제하고 shared token으로 1회 재시도.

- `server/index.js`
  - `CLAW3D_GATEWAY_AUTH_MODE` 처리 추가.
  - mode가 `server-device`일 때만 server device auth 초기화.
  - startup 시 runtime state path log 출력.

- `tests/unit/gatewayProxy.test.ts`
  - server-device upstream connect behavior coverage 추가.
  - upstream challenge가 proxy/server auth에 의해 소비되는지 확인.
  - browser connect id가 유지되는지 확인.
  - issued device token이 storage로 전달되는지 확인.

## Configuration Added

Remote `/home/ubuntu/claw3d/.env`에 추가:

```bash
CLAW3D_GATEWAY_AUTH_MODE=server-device
```

이 동작을 활성화하는 단일 신규 parameter다.

## Verification

Local workspace:

```bash
node -c server/gateway-device-auth.js
node -c server/gateway-proxy.js
node -c server/index.js
npm run test -- --run tests/unit/gatewayProxy.test.ts
```

Result:

```text
12 tests passed
```

Remote `/home/ubuntu/claw3d`:

```bash
node -c server/gateway-device-auth.js
node -c server/gateway-proxy.js
node -c server/index.js
npm run test -- --run tests/unit/gatewayProxy.test.ts
```

Result:

```text
12 tests passed
```

Service restart:

```bash
systemctl --user restart claw3d.service
systemctl --user is-active claw3d.service
```

Result:

```text
active
```

Runtime log confirmed:

```text
Gateway auth mode: server-device (state: /home/ubuntu/.openclaw/claw3d/gateway-device-auth.json)
```

Live WebSocket probe through Claw3D proxy:

```json
{"ok":true}
```

Follow-up logs showed first shared-token connect, then stored device-token reuse:

```text
[gateway-device-auth] connect device=8bc0485c388d auth=shared-token
[gateway-device-auth] connect device=8bc0485c388d auth=device-token
```

## Operational Result

OpenClaw source는 수정하지 않았다. Claw3D는 이제 persistent server device로 upstream 인증한다. 여러 브라우저는 Claw3D 자체 access gate를 통과하면, 각 브라우저별 OpenClaw device pairing 없이 Claw3D를 사용할 수 있어야 한다.

## Notes

- server device auth store는 runtime state이며 commit하면 안 된다.
- OpenClaw가 device token을 rotate/revoke하면, Claw3D는 거부된 stored token을 삭제하고 configured shared Gateway token으로 1회 재시도한다.
- Claw3D server device identity file이 삭제되면 새 server device identity가 생성되며, 다시 pairing 또는 token-based first connect가 필요할 수 있다.
