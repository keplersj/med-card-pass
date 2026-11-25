// End-to-end test: parse a made-up card PDF, draw the wallet card, build a .pkpass,
// sign its manifest with a throwaway test certificate, and verify the signature with OpenSSL.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { makeSamplePdf, SAMPLE } from './make-sample.mjs';
import { signDetached, validManifest, makeSelfSigned, signDetachedWith } from '../src/cms.js';
import { onRequestGet as configGet } from '../functions/api/config.js';
import { onRequestPost as signPost } from '../functions/api/sign.js';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const jsQR = require('jsqr');
const qrcode = require('qrcode-generator');
// The browser scripts attach themselves to globalThis when loaded as modules.
await import('../public/core.js');
await import('../public/pass.js');
const { MedCard, MedPass } = globalThis;

const makeCanvas = (w, h) => { const canvas = createCanvas(w, h); return { canvas, ctx: canvas.getContext('2d') }; };
const canvasFactory = {
  create: (w, h) => { const canvas = createCanvas(w, h); return { canvas, context: canvas.getContext('2d') }; },
  reset: (cc, w, h) => { cc.canvas.width = w; cc.canvas.height = h; },
  destroy: cc => { cc.canvas.width = 0; cc.canvas.height = 0; },
};
const toBytes = async canvas => new Uint8Array(canvas.toBuffer('image/png'));
const ok = msg => console.log('ok -', msg);
const work = mkdtempSync(join(tmpdir(), 'medcard-'));

// 1. Parse the sample PDF.
const card = await MedCard.readCard(await makeSamplePdf(), { pdfjsLib, makeCanvas, jsQR, docOptions: { canvasFactory, verbosity: 0 } });
for (const k of Object.keys(SAMPLE)) assert.equal(card[k], SAMPLE[k], k);
ok('reads QR code, patient ID, name, dates and provider from the PDF');

// 2. The wallet card image carries the same QR text.
const { canvas, ctx } = makeCanvas(10, 10);
MedCard.drawCard(ctx, { ...card, showDob: true }, qrcode, {});
const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
assert.equal(jsQR(img.data, canvas.width, canvas.height)?.data, SAMPLE.qr);
ok('card image QR code round-trips exactly');

// 3. Throwaway CA and signer certificate standing in for Apple WWDR and a Pass Type ID cert.
const sh = (...a) => execFileSync('openssl', a, { cwd: work, stdio: 'pipe' });
sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test WWDR');
sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'pass.key', '-out', 'pass.csr', '-subj', '/UID=pass.test.medcard/CN=Pass Type ID: pass.test.medcard/OU=TEST123456');
sh('x509', '-req', '-in', 'pass.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'pass.pem', '-days', '2');
const env = {
  PASS_TYPE_ID: 'pass.test.medcard', TEAM_ID: 'TEST123456', ORG_NAME: 'Med Card Pass Test',
  PASS_CERT_PEM: readFileSync(join(work, 'pass.pem'), 'utf8'),
  PASS_KEY_PEM: readFileSync(join(work, 'pass.key'), 'utf8'),
  WWDR_CERT_PEM: readFileSync(join(work, 'ca.pem'), 'utf8'),
};

// 4. Functions: config off without secrets, on with them; sign rejects junk.
assert.equal((await (await configGet({ env: {} })).json()).signing, false);
const cfg = await (await configGet({ env })).json();
assert.equal(cfg.signing, true);
assert.equal((await signPost({ env: {}, request: new Request('http://x/api/sign', { method: 'POST', body: '{}' }) })).status, 501);
assert.equal((await signPost({ env, request: new Request('http://x/api/sign', { method: 'POST', body: '{"pass.json":"nope"}' }) })).status, 400);
assert.equal(validManifest('{"pass.json":"' + 'a'.repeat(40) + '"}'), true);
ok('config and sign endpoints behave with and without a certificate');

// 5. Build a .pkpass through the sign endpoint, and check the archive and signature.
const sign = async manifest => {
  const r = await signPost({ env, request: new Request('http://x/api/sign', { method: 'POST', body: manifest }) });
  assert.equal(r.status, 200);
  return new Uint8Array(await r.arrayBuffer());
};
const pkpass = await MedPass.buildPkpass({ ...card, title: 'Medical Cannabis Card', showDob: true }, cfg, { makeCanvas, toBytes, sign, JSZip });
const zip = await JSZip.loadAsync(pkpass);
const names = Object.keys(zip.files).sort();
assert.deepEqual(names, ['icon.png', 'icon@2x.png', 'icon@3x.png', 'manifest.json', 'pass.json', 'signature']);
const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
for (const n of names.filter(n => n !== 'manifest.json' && n !== 'signature')) {
  assert.equal(manifest[n], await MedPass.sha1Hex(await zip.file(n).async('uint8array')), 'hash ' + n);
}
const pass = JSON.parse(await zip.file('pass.json').async('string'));
assert.equal(pass.passTypeIdentifier, 'pass.test.medcard');
assert.equal(pass.barcodes[0].message, SAMPLE.qr);
assert.equal(pass.generic.secondaryFields[0].value, SAMPLE.id);
mkdirSync(join(work, 'p'), { recursive: true });
writeFileSync(join(work, 'p', 'manifest.json'), await zip.file('manifest.json').async('uint8array'));
writeFileSync(join(work, 'p', 'signature'), await zip.file('signature').async('uint8array'));
sh('cms', '-verify', '-binary', '-inform', 'DER', '-in', 'p/signature', '-content', 'p/manifest.json', '-CAfile', 'ca.pem', '-purpose', 'any', '-out', '/dev/null');
ok('.pkpass has the right files and hashes, and OpenSSL verifies its signature');

// 6. The signer sees only hashes: the manifest holds no card details.
const m = await zip.file('manifest.json').async('string');
for (const v of [SAMPLE.name, SAMPLE.id, SAMPLE.qr]) assert.ok(!m.includes(v));
ok('nothing from the card is in what gets sent for signing');

// 7. Direct signer call works on its own too.
const sig = await signDetached(new TextEncoder().encode('{"pass.json":"' + '0'.repeat(40) + '"}'), { certPem: env.PASS_CERT_PEM, keyPem: env.PASS_KEY_PEM, chainPems: [env.WWDR_CERT_PEM] });
assert.ok(sig.length > 1000);

// 8. No Apple certificate: a test pass signed with a throwaway self-signed cert made by the same code the browser uses.
const TEST = { passTypeIdentifier: 'pass.dev.medcardpass.test', teamIdentifier: 'MCPTEST000', organizationName: 'Med Card Pass' };
const self = await makeSelfSigned(TEST);
const testPass = await MedPass.buildPkpass({ ...card, showDob: true }, TEST, { makeCanvas, toBytes, sign: m => signDetachedWith(m, self), JSZip });
const tz = await JSZip.loadAsync(testPass);
assert.ok(tz.file('signature'));
mkdirSync(join(work, 't'), { recursive: true });
writeFileSync(join(work, 't', 'manifest.json'), await tz.file('manifest.json').async('uint8array'));
writeFileSync(join(work, 't', 'signature'), await tz.file('signature').async('uint8array'));
writeFileSync(join(work, 't', 'cert.der'), self.certDer);
sh('x509', '-inform', 'DER', '-in', 't/cert.der', '-out', 't/cert.pem');
const subj = sh('x509', '-in', 't/cert.pem', '-noout', '-subject').toString();
assert.match(subj, /pass\.dev\.medcardpass\.test/);
sh('verify', '-CAfile', 't/cert.pem', 't/cert.pem');
sh('cms', '-verify', '-binary', '-inform', 'DER', '-in', 't/signature', '-content', 't/manifest.json', '-CAfile', 't/cert.pem', '-purpose', 'any', '-out', '/dev/null');
ok('test pass: self-signed certificate is well formed and OpenSSL verifies the signature');

// 9. Unsigned pass: same files, no signature.
const un = await JSZip.loadAsync(await MedPass.buildPkpass({ ...card, showDob: true }, TEST, { makeCanvas, toBytes, sign: null, JSZip }));
assert.deepEqual(Object.keys(un.files).sort(), ['icon.png', 'icon@2x.png', 'icon@3x.png', 'manifest.json', 'pass.json']);
ok('unsigned pass has everything but the signature');
ok('all tests passed');
