const { Buffer } = require("node:buffer");
const { randomUUID } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");

const DEFAULT_UPSTREAM_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Maximum frame payload size (256 KB). */
const MAX_FRAME_SIZE = 256 * 1024;

/** Sustained frame rate per connection. */
const MAX_FRAMES_PER_SECOND = 60;

/** Allow short startup bursts before rate limiting. */
const MAX_FRAME_BURST = 120;

const buildErrorResponse = (id, code, message) => {
  return {
    type: "res",
    id,
    ok: false,
    error: { code, message },
  };
};

const isObject = (value) => Boolean(value && typeof value === "object");

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Per-connection token bucket rate limiter. */
const createFrameRateLimiter = (
  maxPerSecond = MAX_FRAMES_PER_SECOND,
  maxBurst = MAX_FRAME_BURST
) => {
  let tokens = maxBurst;
  let lastRefillAt = Date.now();

  const refill = () => {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastRefillAt);
    if (elapsedMs <= 0) return;
    const replenished = (elapsedMs / 1000) * maxPerSecond;
    tokens = Math.min(maxBurst, tokens + replenished);
    lastRefillAt = now;
  };

  return {
    check() {
      refill();
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
    destroy() {
      // No-op: token bucket has no timers to clean up.
    },
  };
};

/**
 * Validate upstream URL against an allowlist.
 * If UPSTREAM_ALLOWLIST env var is set, only those hosts are permitted.
 * Format: comma-separated hostnames, e.g. "gateway.percival-labs.ai,localhost"
 */
const isUpstreamAllowed = (url) => {
  const allowlist = (process.env.UPSTREAM_ALLOWLIST || "").trim();
  if (!allowlist) {
    return process.env.NODE_ENV !== "production";
  }
  try {
    const parsed = new URL(url);
    const allowed = allowlist
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    return allowed.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const resolvePathname = (url) => {
  const raw = typeof url === "string" ? url : "";
  const idx = raw.indexOf("?");
  return (idx === -1 ? raw : raw.slice(0, idx)) || "/";
};

const injectAuthToken = (params, token) => {
  const next = isObject(params) ? { ...params } : {};
  const auth = isObject(next.auth) ? { ...next.auth } : {};
  auth.token = token;
  next.auth = auth;
  return next;
};

const resolveOriginForUpstream = (upstreamUrl) => {
  const url = new URL(upstreamUrl);
  const proto = url.protocol === "wss:" ? "https:" : "http:";
  const hostname =
    url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "0.0.0.0"
      ? "localhost"
      : url.hostname;
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return `${proto}//${host}`;
};

const hasNonEmptyToken = (params) => {
  const raw = params && isObject(params) && isObject(params.auth) ? params.auth.token : "";
  return typeof raw === "string" && raw.trim().length > 0;
};

const hasNonEmptyPassword = (params) => {
  const raw = params && isObject(params) && isObject(params.auth) ? params.auth.password : "";
  return typeof raw === "string" && raw.trim().length > 0;
};

const hasNonEmptyDeviceToken = (params) => {
  const raw = params && isObject(params) && isObject(params.auth) ? params.auth.deviceToken : "";
  return typeof raw === "string" && raw.trim().length > 0;
};

const hasCompleteDeviceAuth = (params) => {
  const device = params && isObject(params) && isObject(params.device) ? params.device : null;
  if (!device) {
    return false;
  }
  const id = typeof device.id === "string" ? device.id.trim() : "";
  const publicKey = typeof device.publicKey === "string" ? device.publicKey.trim() : "";
  const signature = typeof device.signature === "string" ? device.signature.trim() : "";
  const nonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
  const signedAt = device.signedAt;
  return (
    id.length > 0 &&
    publicKey.length > 0 &&
    signature.length > 0 &&
    nonce.length > 0 &&
    Number.isFinite(signedAt) &&
    signedAt >= 0
  );
};

function createGatewayProxy(options) {
  const {
    loadUpstreamSettings,
    allowWs = (req) => resolvePathname(req.url) === "/api/gateway/ws",
    log = () => {},
    logError = (msg, err) => console.error(msg, err),
    upstreamHandshakeTimeoutMs = DEFAULT_UPSTREAM_HANDSHAKE_TIMEOUT_MS,
    gatewayAuthMode = "browser",
    serverDeviceAuth = null,
  } = options || {};

  const { verifyClient } = options || {};

  if (typeof loadUpstreamSettings !== "function") {
    throw new Error("createGatewayProxy requires loadUpstreamSettings().");
  }

  const wss = new WebSocketServer({ noServer: true, verifyClient });

  wss.on("connection", (browserWs) => {
    let upstreamWs = null;
    let upstreamReady = false;
    let upstreamUrl = "";
    let upstreamToken = "";
    let upstreamAdapterType = "openclaw";
    let connectRequestId = null;
    let connectResponseSent = false;
    let pendingConnectFrame = null;
    let activeServerDeviceConnectFrame = null;
    let upstreamConnectRequestId = null;
    let upstreamConnectAuthSource = null;
    let upstreamConnectRetriedWithSharedToken = false;
    let upstreamConnectNonce = null;
    let pendingUpstreamSetupError = null;
    let closed = false;
    const frameRateLimiter = createFrameRateLimiter();
    let upstreamHandshakeTimeoutId = null;

    const closeBoth = (code, reason) => {
      if (closed) return;
      closed = true;
      frameRateLimiter.destroy();
      if (upstreamHandshakeTimeoutId !== null) {
        clearTimeout(upstreamHandshakeTimeoutId);
        upstreamHandshakeTimeoutId = null;
      }
      try {
        browserWs.close(code, reason);
      } catch {}
      try {
        upstreamWs?.close(code, reason);
      } catch {}
    };

    const sendToBrowser = (frame) => {
      if (browserWs.readyState !== WebSocket.OPEN) return;
      browserWs.send(JSON.stringify(frame));
    };

    const sendConnectError = (code, message) => {
      if (connectRequestId && !connectResponseSent) {
        connectResponseSent = true;
        sendToBrowser(buildErrorResponse(connectRequestId, code, message));
      }
      closeBoth(1011, "connect failed");
    };

    const useServerDeviceAuth = () =>
      gatewayAuthMode === "server-device" &&
      upstreamAdapterType === "openclaw" &&
      serverDeviceAuth &&
      typeof serverDeviceAuth.buildConnectFrame === "function";

    const isConnectChallenge = (frame) =>
      frame &&
      isObject(frame) &&
      frame.type === "event" &&
      frame.event === "connect.challenge" &&
      isObject(frame.payload) &&
      typeof frame.payload.nonce === "string" &&
      frame.payload.nonce.trim().length > 0;

    const isDeviceTokenRejected = (frame) => {
      if (!frame || !isObject(frame) || frame.ok !== false || !isObject(frame.error)) {
        return false;
      }
      const error = frame.error;
      const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
      const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
      const details = isObject(error.details) ? error.details : null;
      const detailCode = typeof details?.code === "string" ? details.code.toLowerCase() : "";
      const authReason =
        typeof details?.authReason === "string" ? details.authReason.toLowerCase() : "";
      return (
        code.includes("unauthorized") ||
        detailCode.includes("device_token") ||
        authReason.includes("device_token") ||
        message.includes("device token")
      );
    };

    const sendServerDeviceConnectFrame = (browserFrame) => {
      if (!upstreamReady || upstreamWs?.readyState !== WebSocket.OPEN) {
        pendingConnectFrame = browserFrame;
        return;
      }
      if (!upstreamConnectNonce) {
        pendingConnectFrame = browserFrame;
        return;
      }
      if (upstreamConnectRequestId && !connectResponseSent) {
        return;
      }
      activeServerDeviceConnectFrame = browserFrame;
      const upstreamId = randomUUID();
      let built;
      try {
        built = serverDeviceAuth.buildConnectFrame({
          id: upstreamId,
          upstreamUrl,
          upstreamToken,
          nonce: upstreamConnectNonce,
          clientVersion: process.env.npm_package_version || "claw3d-server",
        });
      } catch (err) {
        logError("Failed to build server device gateway connect frame.", err);
        sendConnectError(
          "studio.server_device_auth_failed",
          "Failed to create Claw3D server device authentication."
        );
        return;
      }
      upstreamConnectRequestId = upstreamId;
      upstreamConnectAuthSource = built.authSource || null;
      upstreamWs.send(JSON.stringify(built.frame));
    };

    const forwardConnectFrame = (frame) => {
      if (useServerDeviceAuth()) {
        sendServerDeviceConnectFrame(frame);
        return;
      }

      const browserHasAuth =
        hasNonEmptyToken(frame.params) ||
        hasNonEmptyPassword(frame.params) ||
        hasNonEmptyDeviceToken(frame.params) ||
        hasCompleteDeviceAuth(frame.params);

      const requiresToken = upstreamAdapterType === "openclaw";
      if (requiresToken && !upstreamToken && !browserHasAuth) {
        sendConnectError(
          "studio.gateway_token_missing",
          "Upstream gateway token is not configured on the Studio host."
        );
        return;
      }

      const connectFrame = browserHasAuth
        ? frame
        : {
            ...frame,
            params: injectAuthToken(frame.params, upstreamToken),
          };
      upstreamWs.send(JSON.stringify(connectFrame));
    };

    const maybeForwardPendingConnect = () => {
      if (!pendingConnectFrame || !upstreamReady || upstreamWs?.readyState !== WebSocket.OPEN) {
        return;
      }
      const frame = pendingConnectFrame;
      pendingConnectFrame = null;
      forwardConnectFrame(frame);
    };

    const startUpstream = async () => {
      try {
        const settings = await loadUpstreamSettings();
        upstreamUrl = typeof settings?.url === "string" ? settings.url.trim() : "";
        upstreamToken = typeof settings?.token === "string" ? settings.token.trim() : "";
        upstreamAdapterType =
          typeof settings?.adapterType === "string" && settings.adapterType.trim()
            ? settings.adapterType.trim().toLowerCase()
            : "openclaw";
      } catch (err) {
        logError("Failed to load upstream gateway settings.", err);
        pendingUpstreamSetupError = {
          code: "studio.settings_load_failed",
          message: "Failed to load Studio gateway settings.",
        };
        return;
      }

      if (!upstreamUrl) {
        pendingUpstreamSetupError = {
          code: "studio.gateway_url_missing",
          message: "Upstream gateway URL is not configured on the Studio host.",
        };
        return;
      }

      if (!isUpstreamAllowed(upstreamUrl)) {
        pendingUpstreamSetupError = {
          code: "studio.gateway_url_blocked",
          message: "Upstream gateway URL is not in the allowed hosts list.",
        };
        return;
      }

      let upstreamOrigin = "";
      try {
        upstreamOrigin = resolveOriginForUpstream(upstreamUrl);
      } catch {
        pendingUpstreamSetupError = {
          code: "studio.gateway_url_invalid",
          message: "Upstream gateway URL is invalid on the Studio host.",
        };
        return;
      }

      upstreamWs = new WebSocket(upstreamUrl, {
        origin: upstreamOrigin,
        handshakeTimeout: upstreamHandshakeTimeoutMs,
      });

      upstreamHandshakeTimeoutId = setTimeout(() => {
        const timeoutError = {
          code: "studio.upstream_timeout",
          message: "Timed out connecting Studio to the upstream gateway WebSocket.",
        };
        pendingUpstreamSetupError = timeoutError;
        try {
          upstreamWs?.terminate();
        } catch {}
        if (connectRequestId) {
          sendConnectError(timeoutError.code, timeoutError.message);
        }
      }, upstreamHandshakeTimeoutMs);

      upstreamWs.on("open", () => {
        if (upstreamHandshakeTimeoutId !== null) {
          clearTimeout(upstreamHandshakeTimeoutId);
          upstreamHandshakeTimeoutId = null;
        }
        upstreamReady = true;
        maybeForwardPendingConnect();
      });

      upstreamWs.on("message", (upRaw) => {
        const upParsed = safeJsonParse(String(upRaw ?? ""));
        if (useServerDeviceAuth() && isConnectChallenge(upParsed)) {
          upstreamConnectNonce = upParsed.payload.nonce.trim();
          maybeForwardPendingConnect();
          return;
        }
        if (
          useServerDeviceAuth() &&
          upParsed &&
          isObject(upParsed) &&
          upParsed.type === "res" &&
          upstreamConnectRequestId &&
          upParsed.id === upstreamConnectRequestId
        ) {
          if (
            upParsed.ok === false &&
            upstreamConnectAuthSource === "device-token" &&
            !upstreamConnectRetriedWithSharedToken &&
            upstreamToken &&
            isDeviceTokenRejected(upParsed) &&
            activeServerDeviceConnectFrame
          ) {
            upstreamConnectRetriedWithSharedToken = true;
            upstreamConnectRequestId = null;
            upstreamConnectAuthSource = null;
            try {
              if (typeof serverDeviceAuth.clearToken === "function") {
                serverDeviceAuth.clearToken({ scope: upstreamUrl, role: "operator" });
              }
            } catch (err) {
              logError("Failed to clear rejected server device token.", err);
            }
            sendServerDeviceConnectFrame(activeServerDeviceConnectFrame);
            return;
          }

          connectResponseSent = true;
          upstreamConnectRequestId = null;
          upstreamConnectAuthSource = null;
          upstreamConnectRetriedWithSharedToken = false;
          if (upParsed.ok && isObject(upParsed.payload)) {
            try {
              if (typeof serverDeviceAuth.storeHelloAuth === "function") {
                serverDeviceAuth.storeHelloAuth({
                  upstreamUrl,
                  auth: upParsed.payload.auth,
                });
              }
            } catch (err) {
              logError("Failed to store server device gateway token.", err);
            }
          }
          sendToBrowser({
            ...upParsed,
            id: connectRequestId || upParsed.id,
          });
          return;
        }
        if (upParsed && isObject(upParsed) && upParsed.type === "res") {
          const resId = typeof upParsed.id === "string" ? upParsed.id : "";
          if (resId && connectRequestId && resId === connectRequestId) {
            connectResponseSent = true;
          }
        }
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(String(upRaw ?? ""));
        }
      });

      upstreamWs.on("close", (code, reasonBuffer) => {
        if (upstreamHandshakeTimeoutId !== null) {
          clearTimeout(upstreamHandshakeTimeoutId);
          upstreamHandshakeTimeoutId = null;
        }
        const reason =
          typeof reasonBuffer === "string"
            ? reasonBuffer
            : Buffer.isBuffer(reasonBuffer)
              ? reasonBuffer.toString()
              : "";
        log(
          `[gateway-proxy] upstream closed code=${code} reason=${reason || "(none)"} hadConnect=${Boolean(connectRequestId)} responseSent=${connectResponseSent}`
        );
        if (!connectRequestId) {
          pendingUpstreamSetupError ||= {
            code: "studio.upstream_closed",
            message: `Upstream gateway closed (${code}): ${reason}`,
          };
          return;
        }
        if (!connectResponseSent && connectRequestId) {
          connectResponseSent = true;
          sendToBrowser(
            buildErrorResponse(
              connectRequestId,
              code === 1008 ? "studio.upstream_rejected" : "studio.upstream_closed",
              code === 1008
                ? `Upstream gateway rejected connect (${code}): ${reason || "no reason provided"}`
                : `Upstream gateway closed (${code}): ${reason}`
            )
          );
          return;
        }
        closeBoth(1012, "upstream closed");
      });

      upstreamWs.on("error", (err) => {
        if (upstreamHandshakeTimeoutId !== null) {
          clearTimeout(upstreamHandshakeTimeoutId);
          upstreamHandshakeTimeoutId = null;
        }
        logError("Upstream gateway WebSocket error.", err);
        if (!connectRequestId) {
          pendingUpstreamSetupError ||= {
            code: "studio.upstream_error",
            message: "Failed to connect to upstream gateway WebSocket.",
          };
          return;
        }
        if (
          pendingUpstreamSetupError?.code === "studio.upstream_timeout" &&
          pendingUpstreamSetupError?.message
        ) {
          sendConnectError(pendingUpstreamSetupError.code, pendingUpstreamSetupError.message);
          return;
        }
        sendConnectError(
          "studio.upstream_error",
          "Failed to connect to upstream gateway WebSocket."
        );
      });

      log("proxy connected");
    };

    void startUpstream();

    browserWs.on("message", async (raw) => {
      const rawStr = String(raw ?? "");
      const rawByteLength = Buffer.byteLength(rawStr, "utf8");

      // Frame size limit
      if (rawByteLength > MAX_FRAME_SIZE) {
        closeBoth(1009, "frame too large");
        return;
      }

      // Rate limiting
      if (!frameRateLimiter.check()) {
        log(
          "[gateway-proxy] proxy rate limit hit (>" +
            MAX_FRAMES_PER_SECOND +
            " frames/s sustained, burst " +
            MAX_FRAME_BURST +
            ")"
        );
        closeBoth(1008, "rate limit exceeded");
        return;
      }

      const parsed = safeJsonParse(rawStr);
      if (!parsed || !isObject(parsed)) {
        closeBoth(1003, "invalid json");
        return;
      }

      if (!connectRequestId) {
        if (parsed.type !== "req" || parsed.method !== "connect") {
          closeBoth(1008, "connect required");
          return;
        }
        const id = typeof parsed.id === "string" ? parsed.id : "";
        if (!id) {
          closeBoth(1008, "connect id required");
          return;
        }
        connectRequestId = id;
        const params = isObject(parsed.params) ? parsed.params : null;
        const client = params && isObject(params.client) ? params.client : null;
        log(
          `[gateway-proxy] connect frame client.id=${
            typeof client?.id === "string" ? client.id : "n/a"
          } client.mode=${
            typeof client?.mode === "string" ? client.mode : "n/a"
          } hasToken=${hasNonEmptyToken(params)} hasDevice=${hasCompleteDeviceAuth(params)}`
        );
        if (pendingUpstreamSetupError) {
          sendConnectError(pendingUpstreamSetupError.code, pendingUpstreamSetupError.message);
          return;
        }
        pendingConnectFrame = parsed;
        maybeForwardPendingConnect();
        return;
      }

      if (!upstreamReady || upstreamWs.readyState !== WebSocket.OPEN) {
        closeBoth(1013, "upstream not ready");
        return;
      }

      if (parsed.type === "req" && parsed.method === "connect" && !connectResponseSent) {
        pendingConnectFrame = null;
        forwardConnectFrame(parsed);
        return;
      }

      upstreamWs.send(JSON.stringify(parsed));
    });

    browserWs.on("close", () => {
      log("[gateway-proxy] browser disconnected");
      closeBoth(1000, "client closed");
    });

    browserWs.on("error", (err) => {
      logError("Browser WebSocket error.", err);
      closeBoth(1011, "client error");
    });
  });

  const handleUpgrade = (req, socket, head) => {
    if (!allowWs(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  return { wss, handleUpgrade };
}

module.exports = { createGatewayProxy };
