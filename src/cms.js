// Minimal PKCS#7 / CMS detached signature for Apple Wallet pass manifests.
// Dependency-free: DER is built by hand and the RSA signature comes from WebCrypto,
// so it runs in Cloudflare Workers / Pages Functions and in Node 20+.

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function derLen(n) {
  if (n < 0x80) return Uint8Array.of(n);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Uint8Array.from([0x80 | b.length, ...b]);
}

function tlv(tag, ...parts) {
  const body = concat(parts);
  return concat([Uint8Array.of(tag), derLen(body.length), body]);
}

const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const NULL = Uint8Array.of(0x05, 0x00);

function oid(str) {
  const n = str.split('.').map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) { b.unshift((x & 0x7f) | 0x80); x = Math.floor(x / 128); }
    out.push(...b);
  }
  return tlv(0x06, Uint8Array.from(out));
}

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
};

// Read one DER element: returns {tag, start, headerLength, length, end}.
function readTlv(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr += n;
  }
  return { tag, start: off, headerLength: hdr, length: len, end: off + hdr + len };
}

// Pull the raw issuer Name and serial number out of an X.509 certificate.
export function issuerAndSerial(certDer) {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(certDer, cert.start + cert.headerLength);
  let p = tbs.start + tbs.headerLength;
  let el = readTlv(certDer, p);
  if (el.tag === 0xa0) { p = el.end; el = readTlv(certDer, p); } // explicit version
  const serial = certDer.slice(el.start, el.end);
  const sigAlg = readTlv(certDer, el.end);
  const issuer = readTlv(certDer, sigAlg.end);
  return { issuer: certDer.slice(issuer.start, issuer.end), serial };
}

export function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utcTime(d) {
  const p = n => String(n).padStart(2, '0');
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, enc.encode(s));
}

function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Sign `content` (the manifest.json bytes) and return a DER CMS SignedData
 * with no embedded content, as Apple Wallet expects in a pass's `signature` file.
 * certPem: the Pass Type ID certificate. keyPem: its PKCS#8 private key.
 * chainPems: extra certificates to include (Apple WWDR intermediate).
 */
export async function signDetached(content, { certPem, keyPem, chainPems = [], now = new Date() }) {
  const subtle = globalThis.crypto.subtle;
  const certDer = pemToDer(certPem);
  const chain = chainPems.filter(Boolean).map(pemToDer);
  const key = await subtle.importKey('pkcs8', pemToDer(keyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await subtle.digest('SHA-256', content));

  const attrs = [
    seq(oid(OID.contentType), set(oid(OID.data))),
    seq(oid(OID.signingTime), set(utcTime(now))),
    seq(oid(OID.messageDigest), set(tlv(0x04, digest))),
  ].sort(compareBytes); // DER SET OF is sorted
  const attrsBody = concat(attrs);
  const toSign = tlv(0x31, attrsBody);
  const sig = new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', key, toSign));

  const { issuer, serial } = issuerAndSerial(certDer);
  const sha256Alg = seq(oid(OID.sha256), NULL);
  const signerInfo = seq(
    tlv(0x02, Uint8Array.of(1)),
    seq(issuer, serial),
    sha256Alg,
    tlv(0xa0, attrsBody),
    seq(oid(OID.rsaEncryption), NULL),
    tlv(0x04, sig),
  );
  const signedData = seq(
    tlv(0x02, Uint8Array.of(1)),
    set(sha256Alg),
    seq(oid(OID.data)),
    tlv(0xa0, certDer, ...chain),
    set(signerInfo),
  );
  return seq(oid(OID.signedData), tlv(0xa0, signedData));
}

// A pass manifest: an object of file name -> SHA-1 hex, with pass.json in it.
export function validManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { return false; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const keys = Object.keys(m);
  if (!keys.includes('pass.json') || keys.length > 24) return false;
  return keys.every(k => /^[A-Za-z0-9@._-]{1,64}$/.test(k) && k !== 'manifest.json' && k !== 'signature' &&
    typeof m[k] === 'string' && /^[0-9a-f]{40}$/.test(m[k]));
}
