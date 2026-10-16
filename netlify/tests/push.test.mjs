import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { b64u, encryptPayload, endpointOk, vapidHeader, vapidKeys, validSubscription } from "../lib/push.mjs";

const hkdf = (salt, ikm, info, len) => Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

// A receiver written from RFC 8291 section 3.4 (what a browser does), independent of the sender code path.
function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const uaPub = uaEcdh.getPublicKey();
  const prk = hkdf(auth, uaEcdh.computeSecret(asPub), Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32);
  const cek = hkdf(salt, prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "last-record padding delimiter");
  return plain.subarray(0, plain.length - 1);
}

test("payload round-trips through an independent receiver", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = randomBytes(16);
  const msg = Buffer.from(JSON.stringify({ title: "Héllo ✓", body: "x".repeat(500) }));
  assert.deepEqual(decrypt(encryptPayload(msg, ua.getPublicKey(), auth), ua, auth), msg);
});

test("VAPID key is stable per secret, differs between secrets, and its JWT verifies", () => {
  const a = vapidKeys("correct-horse-battery"), b = vapidKeys("another-secret-value");
  assert.notDeepEqual(a.pub, b.pub);
  assert.deepEqual(vapidKeys("correct-horse-battery").pub, a.pub);
  assert.equal(a.pub.length, 65);
  const now = 1_800_000_000;
  const h = vapidHeader("correct-horse-battery", "https://fcm.googleapis.com/fcm/send/abc", "https://site.test", now);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, b64u(a.pub));
  const [head, claims, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { typ: "JWT", alg: "ES256" });
  const c = JSON.parse(Buffer.from(claims, "base64url"));
  assert.deepEqual([c.aud, c.sub, c.exp], ["https://fcm.googleapis.com", "https://site.test", now + 43200]);
  const pubKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(a.pub.subarray(1, 33)), y: b64u(a.pub.subarray(33, 65)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("only real push-service endpoints and well-formed keys are accepted", () => {
  assert.ok(endpointOk("https://fcm.googleapis.com/fcm/send/x"));
  assert.ok(endpointOk("https://updates.push.services.mozilla.com/wpush/v2/x"));
  for (const bad of ["http://fcm.googleapis.com/x", "https://169.254.169.254/x", "https://evilgoogleapis.com/x", "https://fcm.googleapis.com.evil.com/x", "nope"]) assert.equal(endpointOk(bad), false, bad);
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const good = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) } };
  assert.ok(validSubscription(good));
  assert.equal(validSubscription({ ...good, keys: { ...good.keys, auth: "short" } }), false);
});

test("write a fixture for the independent Python cross-check", () => {
  const dir = process.env.PUSH_FIXTURE_DIR;
  if (!dir) return;
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = randomBytes(16);
  const message = "cross-check ✓ " + "m".repeat(300);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/fixture.json`, JSON.stringify({
    ua_private: ua.getPrivateKey().toString("hex"), ua_public: ua.getPublicKey().toString("hex"), auth: auth.toString("hex"),
    body: encryptPayload(Buffer.from(message), ua.getPublicKey(), auth).toString("hex"), message,
    vapid: vapidHeader("correct-horse-battery", "https://fcm.googleapis.com/fcm/send/abc", "https://site.test", 1_800_000_000),
    vapid_pub: vapidKeys("correct-horse-battery").pub.toString("hex"),
  }));
});
