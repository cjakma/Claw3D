# 260512 Claw3D Multi-Browser Modify

## Summary

Claw3D initially appeared to allow only one authenticated browser to connect to OpenClaw. Investigation showed that the limiting factor was not Claw3D's HTTP access gate. The actual issue was OpenClaw Gateway device pairing: each browser generated and stored its own Ed25519 device identity in `localStorage`, so a new browser appeared to OpenClaw as a completely new, unpaired device.

The selected fix was to make the Claw3D server itself act as the OpenClaw Gateway device. With this approach, browsers authenticate to Claw3D as before, while upstream OpenClaw sees one persistent Claw3D server device. This avoids modifying OpenClaw source code and avoids copying browser private keys or device tokens between browsers.

## Key Findings

- Claw3D's `server/access-gate.js` uses a `studio_access` cookie and does not inherently restrict access to one browser.
- Browser-side Gateway auth in `src/lib/gateway/openclaw/GatewayBrowserClient.ts` stores device identity and device token in browser `localStorage`.
- OpenClaw verifies `device.id`, `publicKey`, `signature`, `signedAt`, and Gateway nonce.
- A new browser means a new public key fingerprint, which OpenClaw treats as a new device requiring pairing.
- A single static `params.device` parameter is not enough, because signatures must be generated per connection nonce.
- Injecting a gateway token after browser signing is unsafe/invalid because OpenClaw includes the auth token/device token in the signed payload.

## Implemented Solution

Implemented `CLAW3D_GATEWAY_AUTH_MODE=server-device`.

In this mode:

- Browser connects to Claw3D's same-origin WebSocket proxy as usual.
- Claw3D server opens the upstream OpenClaw Gateway WebSocket.
- Claw3D server consumes the upstream `connect.challenge`.
- Claw3D server signs the upstream `connect` payload using its persistent Ed25519 server device identity.
- OpenClaw issues a `deviceToken` to the Claw3D server device.
- Claw3D stores and reuses that token on later connections.
- Browser connect response ids are preserved so the frontend connection flow keeps working.

## Files Changed

### Added

- `server/gateway-device-auth.js`
  - Persistent Claw3D server device identity.
  - Ed25519 key generation and fingerprint derivation.
  - OpenClaw v2 device-auth payload signing.
  - Device token storage and reuse.
  - Stored at runtime under:

```text
/home/ubuntu/.openclaw/claw3d/gateway-device-auth.json
```

### Modified

- `server/gateway-proxy.js`
  - Added `gatewayAuthMode` and `serverDeviceAuth` options.
  - Added server-device upstream connect flow.
  - Consumes upstream `connect.challenge` in server-device mode.
  - Builds upstream connect frames with server-signed `params.device`.
  - Maps upstream connect response back to the browser's original connect request id.
  - Stores issued `deviceToken`.
  - Clears rejected stored device tokens and retries once with shared token.

- `server/index.js`
  - Added `CLAW3D_GATEWAY_AUTH_MODE` handling.
  - Initializes server device auth only when mode is `server-device`.
  - Logs runtime state path on startup.

- `tests/unit/gatewayProxy.test.ts`
  - Added coverage for server-device upstream connect behavior.
  - Ensures upstream challenge is consumed by proxy/server auth.
  - Ensures browser connect id is preserved.
  - Ensures issued device token is passed to storage.

## Configuration Added

On remote `/home/ubuntu/claw3d/.env`:

```bash
CLAW3D_GATEWAY_AUTH_MODE=server-device
```

This is the single new parameter used to activate the behavior.

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

OpenClaw source was not changed. Claw3D now authenticates upstream as a persistent server device. Multiple browsers should be able to use Claw3D after passing Claw3D's own access gate, without each browser needing separate OpenClaw device pairing.

## Notes

- The server device auth store is runtime state and should not be committed.
- If OpenClaw rotates/revokes the device token, Claw3D will clear the rejected stored token and retry once with the configured shared Gateway token.
- If the Claw3D server device identity file is deleted, a new server device identity will be generated and may require pairing or token-based first connect again.
