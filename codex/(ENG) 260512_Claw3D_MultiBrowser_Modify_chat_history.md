# 260512 Claw3D Multi-Browser Modify Chat History

> Note: This file records the working thread in a sanitized form. Personal/local credential paths, such as the SSH private key path, are redacted because this file is stored inside the repository.

## Initial Context

The repository instructions identified this project as Claw3D, a Next.js 16 frontend for OpenClaw. The app runs through a custom Node.js server (`server/index.js`) with a same-origin WebSocket proxy to the upstream OpenClaw Gateway.

Important repository constraints:

- Keep OpenClaw runtime/source separate from this repository.
- Do not modify OpenClaw source code.
- Apply requested changes to this Claw3D app.
- When needed, inspect OpenClaw source/runtime only to understand protocol behavior.
- Avoid committing private, environment-specific, or secret instructions.

## User Request 1: Analyze Multi-Browser Access

The user provided:

- SSH protocol and host: `<WEB_SERVER_DOMAIN>`
- SSH user: `ubuntu`
- SSH key path: `[redacted local private key path]`
- Relevant remote directories: `/home/ubuntu`, `/home/ubuntu/claw3d`
- OpenClaw URL: `https://<WEB_SERVER_OPENCLAW_DOMAIN>/chat?session=agent%3Amain%3Amain`
- Claw3D URL: `https://<WEB_SERVER_CLAW3D_DOMAIN>/office`

The user stated both URLs were reachable, but Claw3D appeared to allow access only from the single browser that had already completed authentication. They asked for code analysis under `/home/ubuntu/claw3d` to allow the same user to access Claw3D from multiple browsers. They wanted minimal extra parameters, ideally around one parameter. They also provided the intended `params.device` shape:

```js
params: {
  device: {
    id: "...",          // public key fingerprint
    publicKey: "...",   // Ed25519 public key
    signature: "...",   // connect payload signed with the private key
    signedAt: 123456,
    nonce: "..."        // included when the gateway sends a challenge
  }
}
```

## Assistant Analysis 1

The assistant first inspected the local workspace, then the remote `/home/ubuntu/claw3d`.

Key local files reviewed:

- `src/lib/gateway/GatewayClient.ts`
- `src/lib/gateway/openclaw/GatewayBrowserClient.ts`
- `server/gateway-proxy.js`
- `server/access-gate.js`
- `tests/unit/gatewayProxy.test.ts`

Key findings:

- Claw3D already generated `params.device` in the browser client.
- The browser device identity and device token were stored in browser `localStorage`.
- `server/access-gate.js` used a simple `studio_access` cookie and did not enforce single-browser access itself.
- `server/gateway-proxy.js` forwarded browser connect frames to OpenClaw Gateway and could inject a host token only when the browser did not already provide auth/device material.

The assistant then inspected OpenClaw runtime code under:

- `/home/ubuntu/.nvm/versions/node/v24.15.0/lib/node_modules/openclaw/dist/...`

OpenClaw behavior found:

- Gateway emits `connect.challenge` with a nonce.
- Gateway requires `device.id` to match the public key fingerprint.
- Gateway verifies `signedAt`, `nonce`, and Ed25519 signature.
- Gateway checks whether that device is paired under `/home/ubuntu/.openclaw/devices`.
- New browser localStorage means a new key pair, so OpenClaw sees it as a new device even if it is the same human user.

Important conclusion:

- The problem was not Claw3D HTTP access gate being single-browser.
- The problem was OpenClaw Gateway device pairing being browser-local.
- A static `params.device` URL parameter would not solve the problem because the signature must be recomputed per Gateway nonce and current `signedAt`.

## Assistant Recommendation 1

The assistant proposed three options:

1. Approve each browser as a separate OpenClaw device using `openclaw devices approve --latest`.
2. Use one URL parameter such as `deviceImport=<encrypted one-time bundle>` to copy an approved browser identity/token into another browser.
3. Make the Claw3D server itself become the Gateway device.

Recommendation:

- Use option 3: Claw3D server becomes the OpenClaw Gateway device.
- Browser access would be governed by Claw3D's access gate.
- Upstream OpenClaw would only see one approved Claw3D server device.
- No OpenClaw source code changes would be needed.

## User Request 2: Estimate Work for Server Device Approach

The user asked how much work option 3 would require.

## Assistant Analysis 2

The assistant inspected whether Claw3D already had server-side Gateway/device signing utilities.

Files reviewed:

- `package.json`
- `src/lib/gateway/nodeGatewayClient.ts`
- `server/index.js`

Key findings:

- `@noble/ed25519` was already a dependency.
- `src/lib/gateway/nodeGatewayClient.ts` already had server-side Ed25519 signing logic, but created a fresh identity each time and was not suitable as persistent production proxy identity.
- The proxy would need a persistent server device identity and device token store.

## Assistant Estimate 2

Estimated work:

- MVP: half day to one day.
- Stabilized version: 1.5 to 3 days.

Expected changes:

- Add persistent server device auth module.
- Extend `server/gateway-proxy.js` with `server-device` mode.
- Add one env parameter, e.g. `CLAW3D_GATEWAY_AUTH_MODE=server-device`.
- Update tests.
- Deploy and restart Claw3D service.

Important caveat:

- The proxy cannot simply inject a token after the browser signs because OpenClaw includes the auth token/device token in the signed payload. Therefore, the Claw3D server must perform the upstream `connect` signature itself.

## User Request 3: Implement Without Modifying OpenClaw

The user requested:

- Do not modify OpenClaw source.
- Modify only Claw3D proxy/server authentication layer.
- After modifying remote `/home/ubuntu/claw3d`, apply the same content to local `C:\env\workspace\260417_Claw3D_cjakma`.

## Assistant Implementation 3

The assistant implemented the change locally first, then copied the same files to remote.

Local files changed:

- `server/gateway-device-auth.js` added.
- `server/gateway-proxy.js` modified.
- `server/index.js` modified.
- `tests/unit/gatewayProxy.test.ts` modified.

Implementation summary:

- Added a new persistent server-side Gateway device auth module.
- The module creates and stores an Ed25519 server device identity.
- The module signs OpenClaw `connect.challenge` nonce payloads.
- The module stores issued OpenClaw `deviceToken`s and reuses them.
- The proxy can run in `CLAW3D_GATEWAY_AUTH_MODE=server-device`.
- In server-device mode, browser connect frames trigger upstream connect, but the upstream connect is built and signed by the Claw3D server.
- The browser's original connect response id is preserved when returning `hello-ok`.
- If a stored device token is rejected, the proxy clears it and falls back once to the shared upstream token.

## Local Verification

The first local test run failed because `node_modules` was missing:

```text
'vitest' is not recognized as an internal or external command
```

The assistant ran:

```bash
npm ci
```

Then verified:

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

The assistant copied these local files to `/home/ubuntu/claw3d`:

- `server/gateway-device-auth.js`
- `server/gateway-proxy.js`
- `server/index.js`
- `tests/unit/gatewayProxy.test.ts`

Then added/updated remote `.env`:

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

The server device state file was created:

```text
/home/ubuntu/.openclaw/claw3d/gateway-device-auth.json
```

With permissions:

```text
rw-------
```

## Live Probe

The assistant ran a WebSocket probe through Claw3D's local proxy endpoint on the remote server.

Result:

```json
{"ok":true}
```

Logs showed:

```text
[gateway-device-auth] connect device=8bc0485c388d auth=shared-token
[gateway-device-auth] connect device=8bc0485c388d auth=device-token
```

Meaning:

- The first successful server-device connect used the upstream shared token.
- OpenClaw issued a device token.
- The next connect reused the stored server device token.

## Final Assistant Response 3

The assistant reported completion:

- OpenClaw source was not modified.
- Claw3D proxy/server auth layer was changed.
- Same changes were reflected locally and remotely.
- Remote service was restarted.
- Local and remote unit tests passed.
- Live WebSocket probe returned `{"ok":true}`.
- New browsers should now be able to access Claw3D as long as they pass the Claw3D access gate, while upstream OpenClaw sees the approved Claw3D server device.

## User Request 4: Save This Thread

The user requested creation of:

- `260512_Claw3D_MultiBrowser_Modify_chat_history.md`
- `260512_Claw3D_MultiBrowser_Modify.md`

Both under:

```text
C:\env\workspace\260417_Claw3D_cjakma
```

The user wanted:

- The chat contents saved in the first file.
- A summary plus final change details saved in the second file.

The assistant created this sanitized chat history file and the companion summary/change document.
