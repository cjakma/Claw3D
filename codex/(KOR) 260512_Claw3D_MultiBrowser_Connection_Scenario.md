
현재 운영 서버 기준 신규 브라우저 접속 시나리오는 이렇게 됩니다.

현재 실제 상태

Claw3D URL: https://<WEB_SERVER_CLAW3D_DOMAIN>/office
Claw3D 인증 모드: CLAW3D_GATEWAY_AUTH_MODE=server-device
Claw3D access cookie 이름: studio_access
STUDIO_ACCESS_TOKEN: 서버 .env에 있음, 길이 26자
Claw3D server-device id: 8bc0485c388d76bb43a6a09139f5a738fa9b01feee37c45ef938272a98d6849c
server-device token scope: ws://localhost:18789::operator
server-device 저장 파일: /home/ubuntu/.openclaw/claw3d/gateway-device-auth.json
신규 브라우저 접속 절차

새 브라우저에서 Claw3D access token 포함 URL로 접속합니다.
https://<WEB_SERVER_CLAW3D_DOMAIN>/office?token=<STUDIO_ACCESS_TOKEN>
<STUDIO_ACCESS_TOKEN> 값은 서버에서 아래 명령으로 확인하세요. 채팅에는 노출하지 않는 게 좋습니다.

ssh ubuntu@<WEB_SERVER_DOMAIN> "cd /home/ubuntu/claw3d && sed -n 's/^STUDIO_ACCESS_TOKEN=//p' .env"
정상 인증되면 Claw3D가 studio_access 쿠키를 심고, URL에서 token 파라미터를 제거한 뒤 /office로 redirect합니다.

이후 새 브라우저는 별도 OpenClaw device pairing 없이 Claw3D UI를 사용합니다. 브라우저 자체 device identity가 아니라 Claw3D 서버 device가 upstream OpenClaw Gateway에 연결합니다.

정상 동작 시 서버 로그는 대략 이렇게 나옵니다.

[gateway-proxy] connect frame ... hasToken=false hasDevice=false
[gateway-device-auth] connect device=8bc0485c388d auth=device-token
확인 명령

ssh ubuntu@<WEB_SERVER_DOMAIN> "journalctl --user -u claw3d.service -n 30 --no-pager"
문제별 대응

Studio access token required가 나오면: 
새 브라우저에 ?token=<STUDIO_ACCESS_TOKEN> URL로 다시 접속하세요.

OpenClaw pairing required가 나오면: 
server-device identity가 재생성됐을 가능성이 있습니다. 
서버에서 openclaw devices approve --latest를 한 번 실행하면 됩니다.

현재 상태에서는 이미 deviceToken이 저장되어 있어서 신규 브라우저는 바로 이어서 접속되는 구성이 맞습니다.
