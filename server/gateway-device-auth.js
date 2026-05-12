const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { resolveStateDir } = require("./studio-settings");

const GATEWAY_ROLE = "operator";
const GATEWAY_SCOPES = ["operator.admin", "operator.approvals", "operator.pairing"];
const GATEWAY_CLIENT_ID = "openclaw-control-ui";
const GATEWAY_CLIENT_MODE = "webchat";
const STORE_VERSION = 1;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const isObject = (value) => Boolean(value && typeof value === "object");

const base64UrlEncode = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");

const base64UrlDecode = (input) => {
  const normalized = String(input || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
};

const derivePublicKeyRaw = (publicKeyPem) => {
  const spki = crypto.createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
};

const fingerprintPublicKey = (publicKeyPem) =>
  crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");

const publicKeyRawBase64UrlFromPem = (publicKeyPem) =>
  base64UrlEncode(derivePublicKeyRaw(publicKeyPem));

const normalizeAuthScope = (scope) => {
  const trimmed = String(scope || "").trim();
  return trimmed ? trimmed.toLowerCase() : "default";
};

const buildScopedTokenKey = (scope, role) => `${normalizeAuthScope(scope)}::${role.trim()}`;

const normalizeScopes = (scopes) => {
  if (!Array.isArray(scopes)) return [];
  const out = new Set();
  for (const scope of scopes) {
    const trimmed = String(scope || "").trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out].sort();
};

const resolveDefaultStorePath = (env = process.env) =>
  path.join(resolveStateDir(env), "claw3d", "gateway-device-auth.json");

const createIdentity = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    createdAtMs: Date.now(),
  };
};

const defaultStore = () => ({
  version: STORE_VERSION,
  identity: createIdentity(),
  tokens: {},
});

const normalizeStore = (raw) => {
  if (!isObject(raw) || raw.version !== STORE_VERSION) return null;
  const identity = isObject(raw.identity) ? raw.identity : null;
  if (
    !identity ||
    typeof identity.deviceId !== "string" ||
    typeof identity.publicKeyPem !== "string" ||
    typeof identity.privateKeyPem !== "string"
  ) {
    return null;
  }
  const derivedId = fingerprintPublicKey(identity.publicKeyPem);
  if (derivedId !== identity.deviceId) {
    identity.deviceId = derivedId;
  }
  const tokens = isObject(raw.tokens) ? raw.tokens : {};
  return {
    version: STORE_VERSION,
    identity: {
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
      createdAtMs:
        typeof identity.createdAtMs === "number" && Number.isFinite(identity.createdAtMs)
          ? identity.createdAtMs
          : Date.now(),
    },
    tokens,
  };
};

const readStore = (storePath) => {
  try {
    if (!fs.existsSync(storePath)) return defaultStore();
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return normalizeStore(parsed) || defaultStore();
  } catch {
    return defaultStore();
  }
};

const writeStore = (storePath, store) => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {}
};

const buildDeviceAuthPayload = (params) => {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce ?? "",
  ].join("|");
};

const signDevicePayload = (privateKeyPem, payload) =>
  base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem))
  );

const resolveTokenEntry = (store, scope, role) => {
  const key = buildScopedTokenKey(scope, role);
  const entry = store.tokens[key];
  if (!isObject(entry) || typeof entry.token !== "string" || !entry.token.trim()) {
    return null;
  }
  return entry;
};

function createGatewayDeviceAuth(options = {}) {
  const storePath = options.storePath || resolveDefaultStorePath(options.env);
  const log = typeof options.log === "function" ? options.log : () => {};

  const load = () => {
    const store = readStore(storePath);
    writeStore(storePath, store);
    return store;
  };

  const saveToken = ({ scope, role, token, scopes }) => {
    const trimmedToken = String(token || "").trim();
    if (!trimmedToken) return;
    const store = load();
    const key = buildScopedTokenKey(scope, role);
    store.tokens[key] = {
      token: trimmedToken,
      role,
      scopes: normalizeScopes(scopes),
      updatedAtMs: Date.now(),
    };
    writeStore(storePath, store);
  };

  const clearToken = ({ scope, role }) => {
    const store = load();
    const key = buildScopedTokenKey(scope, role);
    if (!store.tokens[key]) return;
    delete store.tokens[key];
    writeStore(storePath, store);
  };

  const buildConnectFrame = ({ id, upstreamUrl, upstreamToken, nonce, clientVersion }) => {
    const store = load();
    const role = GATEWAY_ROLE;
    const scopes = GATEWAY_SCOPES;
    const scope = upstreamUrl;
    const tokenEntry = resolveTokenEntry(store, scope, role);
    const explicitDeviceToken = tokenEntry?.token || "";
    const sharedToken = String(upstreamToken || "").trim();
    const signatureToken = explicitDeviceToken || sharedToken || null;
    const signedAtMs = Date.now();
    const identity = store.identity;
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: GATEWAY_CLIENT_ID,
      clientMode: GATEWAY_CLIENT_MODE,
      role,
      scopes,
      signedAtMs,
      token: signatureToken,
      nonce,
    });
    const auth = explicitDeviceToken
      ? { deviceToken: explicitDeviceToken }
      : sharedToken
        ? { token: sharedToken }
        : undefined;
    log(
      `[gateway-device-auth] connect device=${identity.deviceId.slice(0, 12)} auth=${
        explicitDeviceToken ? "device-token" : sharedToken ? "shared-token" : "none"
      }`
    );
    return {
      frame: {
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: GATEWAY_CLIENT_ID,
            version: clientVersion || "claw3d-server",
            platform: process.platform,
            mode: GATEWAY_CLIENT_MODE,
            instanceId: `claw3d-server:${identity.deviceId}`,
          },
          role,
          scopes,
          device: {
            id: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            signature: signDevicePayload(identity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          },
          caps: [],
          ...(auth ? { auth } : {}),
          userAgent: "claw3d-server",
          locale: "en-US",
        },
      },
      authSource: explicitDeviceToken ? "device-token" : sharedToken ? "shared-token" : "none",
      deviceId: identity.deviceId,
    };
  };

  const storeHelloAuth = ({ upstreamUrl, auth }) => {
    if (!isObject(auth) || typeof auth.deviceToken !== "string" || !auth.deviceToken.trim()) {
      return;
    }
    saveToken({
      scope: upstreamUrl,
      role: typeof auth.role === "string" && auth.role.trim() ? auth.role.trim() : GATEWAY_ROLE,
      token: auth.deviceToken,
      scopes: Array.isArray(auth.scopes) ? auth.scopes : GATEWAY_SCOPES,
    });
  };

  return {
    buildConnectFrame,
    clearToken,
    storeHelloAuth,
    storePath,
  };
}

module.exports = {
  createGatewayDeviceAuth,
  resolveDefaultStorePath,
  // exported for focused unit tests
  _private: {
    buildDeviceAuthPayload,
    publicKeyRawBase64UrlFromPem,
    base64UrlDecode,
  },
};
