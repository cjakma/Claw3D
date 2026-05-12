# 260512 Claw3D Multi-Browser Connection Scenario

This is the new-browser connection scenario based on the current production server state.

## Current Actual State

Claw3D URL: `https://<WEB_SERVER_CLAW3D_DOMAIN>/office`

Claw3D auth mode: `CLAW3D_GATEWAY_AUTH_MODE=server-device`

Claw3D access cookie name: `studio_access`

`STUDIO_ACCESS_TOKEN`: exists in the server `.env`; the value is not recorded in this document.

Claw3D server-device id: `8bc0485c388d76bb43a6a09139f5a738fa9b01feee37c45ef938272a98d6849c`

server-device token scope: `ws://localhost:18789::operator`

server-device storage file: `/home/ubuntu/.openclaw/claw3d/gateway-device-auth.json`

## New Browser Connection Steps

Open Claw3D in the new browser with the access token included in the URL.

```text
https://<WEB_SERVER_CLAW3D_DOMAIN>/office?token=<STUDIO_ACCESS_TOKEN>
```

Check the `<STUDIO_ACCESS_TOKEN>` value on the server with the command below. It is better not to expose this value in chat.

```bash
ssh ubuntu@<WEB_SERVER_DOMAIN> "cd /home/ubuntu/claw3d && sed -n 's/^STUDIO_ACCESS_TOKEN=//p' .env"
```

If authentication succeeds, Claw3D sets the `studio_access` cookie, removes the `token` parameter from the URL, and redirects to `/office`.

After that, the new browser can use the Claw3D UI without separate OpenClaw device pairing. The upstream OpenClaw Gateway connection uses the Claw3D server device, not the browser's own device identity.

When working normally, server logs should look roughly like this.

```text
[gateway-proxy] connect frame ... hasToken=false hasDevice=false
[gateway-device-auth] connect device=8bc0485c388d auth=device-token
```

## Verification Command

```bash
ssh ubuntu@<WEB_SERVER_DOMAIN> "journalctl --user -u claw3d.service -n 30 --no-pager"
```

## Troubleshooting

If `Studio access token required` appears:

Open the new browser again with the `?token=<STUDIO_ACCESS_TOKEN>` URL.

If `OpenClaw pairing required` appears:

The server-device identity may have been regenerated. Run `openclaw devices approve --latest` once on the server.

In the current state, the `deviceToken` is already stored, so new browsers should connect immediately after Claw3D access authentication.
