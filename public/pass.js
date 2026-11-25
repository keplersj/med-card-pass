/* Builds an Apple Wallet .pkpass in the browser.
   Only manifest.json (file names and SHA-1 hashes) is sent to the site's /api/sign
   to be signed; pass.json, with the card's details, never leaves the device.
   Works in the browser (window.MedPass) and in Node for tests. */
(function (root) {
  const enc = new TextEncoder();

  async function sha1Hex(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  // Local end of day for a yyyy-mm-dd date, as an ISO string with offset.
  function endOfDay(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
    const d = new Date(iso + 'T23:59:59');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const p = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
    return iso + 'T23:59:59' + sign + p(off / 60) + ':' + p(off % 60);
  }

  function noon(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso + 'T12:00:00Z' : null;
  }

  // f: {title, id, name, dob, showDob, issued, expiration, provider, qr}
  // cfg: {passTypeIdentifier, teamIdentifier, organizationName}
  function passJson(f, cfg) {
    const date = (key, label, iso, style) => iso ? [{ key, label, value: style === 'end' ? endOfDay(iso) : noon(iso), dateStyle: 'PKDateStyleMedium', ...(style === 'end' ? {} : { ignoresTimeZone: true }) }] : [];
    const text = (key, label, value) => value ? [{ key, label, value }] : [];
    const pass = {
      formatVersion: 1,
      passTypeIdentifier: cfg.passTypeIdentifier,
      teamIdentifier: cfg.teamIdentifier,
      organizationName: cfg.organizationName,
      serialNumber: uuid(),
      description: f.title || 'Medical card',
      logoText: f.title || 'Medical Card',
      foregroundColor: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(18, 67, 77)',
      labelColor: 'rgb(169, 201, 207)',
      sharingProhibited: true,
      generic: {
        primaryFields: text('name', 'NAME', f.name),
        secondaryFields: text('id', 'PATIENT ID', f.id).concat(date('exp', 'EXPIRES', f.expiration, 'end')),
        auxiliaryFields: (f.showDob ? date('dob', 'DATE OF BIRTH', f.dob) : []).concat(date('issued', 'ISSUED', f.issued)),
        backFields: text('provider', 'Provider', f.provider).concat([{
          key: 'note', label: 'About this pass',
          value: 'Made from your card PDF with Med Card Pass. It is a convenience copy, not issued by the state. Keep your official card too.',
        }]),
      },
      barcodes: [{ format: 'PKBarcodeFormatQR', message: f.qr, messageEncoding: 'iso-8859-1', altText: f.id || undefined }],
    };
    const exp = endOfDay(f.expiration);
    if (exp) pass.expirationDate = exp;
    return pass;
  }

  // Simple generic icon: a rounded teal tile with a white card outline.
  function iconPng(size, makeCanvas) {
    const { canvas, ctx } = makeCanvas(size, size);
    const r = size * 0.22;
    ctx.fillStyle = '#12434d';
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(size, 0, size, size, r); ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r); ctx.arcTo(0, 0, size, 0, r); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.5, size * 0.07);
    const w = size * 0.62, h = size * 0.42, x = (size - w) / 2, y = (size - h) / 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#a9c9cf';
    ctx.fillRect(x + w * 0.12, y + h * 0.3, w * 0.28, h * 0.4);
    return canvas;
  }

  // Build every file except the signature. toBytes(canvas) -> Promise<Uint8Array> of a PNG.
  async function buildFiles(f, cfg, makeCanvas, toBytes) {
    const files = { 'pass.json': enc.encode(JSON.stringify(passJson(f, cfg), null, 2)) };
    for (const [name, size] of [['icon.png', 29], ['icon@2x.png', 58], ['icon@3x.png', 87]]) {
      files[name] = await toBytes(iconPng(size, makeCanvas));
    }
    const manifest = {};
    for (const [name, bytes] of Object.entries(files)) manifest[name] = await sha1Hex(bytes);
    files['manifest.json'] = enc.encode(JSON.stringify(manifest));
    return files;
  }

  // sign(manifestBytes) -> Promise<Uint8Array> DER signature. JSZip is passed in.
  async function buildPkpass(f, cfg, { makeCanvas, toBytes, sign, JSZip }) {
    const files = await buildFiles(f, cfg, makeCanvas, toBytes);
    files.signature = await sign(files['manifest.json']);
    const zip = new JSZip();
    for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.apple.pkpass' });
  }

  const api = { passJson, buildFiles, buildPkpass, sha1Hex, endOfDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MedPass = api;
})(typeof window !== 'undefined' ? window : globalThis);
