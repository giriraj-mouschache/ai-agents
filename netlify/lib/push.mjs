// Web Push without dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291), using node:crypto only.
// The VAPID key pair is derived from ADMIN_KEY, so there is nothing extra to store or leak.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, scryptSync, sign } from "node:crypto";

const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
export const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");
const hkdf = (salt, ikm, info, len) => Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

// Only real browser push services are contacted, so a stored endpoint can never point at an internal address.
const PUSH_HOST = /(^|\.)(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export function endpointOk(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === "https:" && PUSH_HOST.test(u.hostname); } catch { return false; }
}

let cached = { secret: null, keys: null };
export function vapidKeys(secret) {
  if (cached.secret === secret) return cached.keys;
  const raw = scryptSync(secret, "research-agent-vapid-v1", 32);
  const d = (BigInt("0x" + raw.toString("hex")) % (N - 1n)) + 1n;
  const priv = Buffer.from(d.toString(16).padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(priv);
  const pub = ecdh.getPublicKey();
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(priv) }, format: "jwk" });
  cached = { secret, keys: { pub, key } };
  return cached.keys;
}

export function vapidHeader(secret, endpoint, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const { pub, key } = vapidKeys(secret);
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${b64u(pub)}`;
}

export function encryptPayload(payload, uaPublic, authSecret) {
  const as = createECDH("prime256v1");
  as.generateKeys();
  const asPub = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const prk = hkdf(authSecret, shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPub]), 32);
  const salt = randomBytes(16);
  const cek = hkdf(salt, prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([salt, Buffer.from([0, 0, 0x10, 0]), Buffer.from([asPub.length]), asPub, body]);
}

export function validSubscription(sub) {
  return Boolean(sub && endpointOk(sub.endpoint) && sub.keys && fromB64u(sub.keys.p256dh).length === 65 && fromB64u(sub.keys.auth).length === 16);
}

/** Sends one notification. Returns { ok, status, gone } (gone = the browser unsubscribed, drop it). */
export async function sendPush(sub, message, { secret, subject }) {
  if (!validSubscription(sub)) return { ok: false, status: 0, gone: true };
  const payload = Buffer.from(JSON.stringify(message).slice(0, 3000));
  const body = encryptPayload(payload, fromB64u(sub.keys.p256dh), fromB64u(sub.keys.auth));
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: { Authorization: vapidHeader(secret, sub.endpoint, subject), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal" },
      body,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { ok: false, status: 0, gone: false };
  }
}
