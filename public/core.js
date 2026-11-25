/* Med card core: reads a card PDF and draws a wallet-ready card image.
   Runs in the browser (window.MedCard) and in Node for tests (module.exports).
   Nothing here touches the network. */
(function (root) {
  const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const ID_RE = /\b[A-Z]{2,4}-\d{2}-\d{4,}\b/;

  function toIso(s) {
    const m = DATE_RE.exec(s.trim());
    if (!m) return '';
    return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  }

  // Group pdf.js text items into line segments, split where a wide gap marks a new column.
  function segments(items) {
    const runs = items
      .filter(it => it.str && it.str.trim())
      .map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
    runs.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const r of runs) {
      const line = lines.find(l => Math.abs(l.y - r.y) < 1.5);
      if (line) line.runs.push(r); else lines.push({ y: r.y, runs: [r] });
    }
    const out = [];
    for (const l of lines) {
      l.runs.sort((a, b) => a.x - b.x);
      let cur = null;
      for (const r of l.runs) {
        if (cur && r.x - cur.end < 24) {
          cur.text += (r.x - cur.end > 1 ? ' ' : '') + r.s;
          cur.end = r.x + r.w;
        } else {
          cur = { text: r.s, x: r.x, y: l.y, end: r.x + r.w };
          out.push(cur);
        }
      }
    }
    out.forEach(o => { o.text = o.text.replace(/\s+/g, ' ').trim(); });
    return out;
  }

  // Find the value column (name, dates, provider) beside the card's printed labels.
  function parseText(segs, qrDob) {
    const res = { name: '', dob: '', issued: '', expiration: '', provider: '', id: '' };
    const idSeg = segs.find(s => ID_RE.test(s.text));
    if (idSeg) res.id = ID_RE.exec(idSeg.text)[0];
    const dates = segs.filter(s => DATE_RE.test(s.text));
    let best = null;
    for (const d of dates) {
      const col = dates.filter(o => Math.abs(o.x - d.x) < 2);
      if (!best || col.length > best.length) best = col;
    }
    if (!best || best.length < 2) return res;
    const x0 = best[0].x;
    const col = segs.filter(s => Math.abs(s.x - x0) < 2).sort((a, b) => b.y - a.y);
    const di = col.map((s, i) => DATE_RE.test(s.text) ? i : -1).filter(i => i >= 0);
    const first = di[0], last = di[di.length - 1];
    if (first > 0 && !DATE_RE.test(col[first - 1].text)) res.name = col[first - 1].text;
    if (last + 1 < col.length && col[first].y - col[last + 1].y < 80) res.provider = col[last + 1].text;
    let iso = di.map(i => toIso(col[i].text));
    if (qrDob && iso.includes(qrDob)) {
      res.dob = qrDob;
      iso.splice(iso.indexOf(qrDob), 1);
    } else if (iso.length >= 3) {
      res.dob = iso.shift();
    }
    iso.sort();
    if (iso.length >= 2) { res.issued = iso[0]; res.expiration = iso[iso.length - 1]; }
    else if (iso.length === 1) res.expiration = iso[0];
    return res;
  }

  function parseQr(text) {
    const out = { id: '', dob: '' };
    const m = ID_RE.exec(text);
    if (m) out.id = m[0];
    else if (text.includes(',')) out.id = text.split(',')[0].trim();
    const d = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
    if (d) out.dob = d[1];
    return out;
  }

  // Render a page and look for a QR code: whole page at a few scales, then quarters.
  async function findQr(page, makeCanvas, jsQR) {
    const tries = [];
    for (const scale of [2, 3.5, 1.4]) tries.push({ scale });
    for (const scale of [4]) for (const q of [[0, 0], [1, 0], [0, 1], [1, 1]]) tries.push({ scale, q });
    for (const t of tries) {
      const vp = page.getViewport({ scale: t.scale });
      const { canvas, ctx } = makeCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      let x = 0, y = 0, w = canvas.width, h = canvas.height;
      if (t.q) { w = Math.ceil(w / 2) + 40; h = Math.ceil(h / 2) + 40; x = t.q[0] ? canvas.width - w : 0; y = t.q[1] ? canvas.height - h : 0; }
      const img = ctx.getImageData(x, y, w, h);
      const r = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
      if (r && r.data) return r.data;
    }
    return '';
  }

  async function readCard(data, libs) {
    const { pdfjsLib, makeCanvas, jsQR } = libs;
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, disableAutoFetch: true, ...(libs.docOptions || {}) }).promise;
    try {
      let qr = '', segs = [];
      for (let p = 1; p <= Math.min(doc.numPages, 3); p++) {
        const page = await doc.getPage(p);
        segs = segs.concat(segments((await page.getTextContent()).items));
        if (!qr) qr = await findQr(page, makeCanvas, jsQR);
        if (qr) break;
      }
      const q = parseQr(qr);
      const t = parseText(segs, q.dob);
      return {
        qr,
        id: q.id || t.id,
        name: t.name,
        dob: q.dob || t.dob,
        issued: t.issued,
        expiration: t.expiration,
        provider: t.provider,
      };
    } finally {
      doc.destroy();
    }
  }

  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1];
    return mon + ' ' + (+m[3]) + ', ' + m[1];
  }

  function fit(ctx, text, weight, size, font, max) {
    do { ctx.font = weight + ' ' + size + 'px ' + font; size -= 2; } while (size > 20 && ctx.measureText(text).width > max);
  }

  // Draw the wallet card: big clean QR on white so Google Wallet's Photo flow reads it.
  function drawCard(ctx, f, qrcode, opt) {
    const W = 1080, H = 1500;
    const font = (opt && opt.font) || 'sans-serif';
    ctx.canvas.width = W; ctx.canvas.height = H;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#12434d'; ctx.fillRect(0, 0, W, 250);
    ctx.fillStyle = '#a9c9cf'; ctx.fillRect(0, 250, W, 14);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 44px ' + font;
    ctx.fillText(f.title || 'Medical Cannabis Card', 72, 120);
    fit(ctx, f.id || 'Patient ID', 700, 64, font, W - 144);
    ctx.fillText(f.id || 'Patient ID', 72, 205);
    if (f.qr) {
      const q = qrcode(0, 'M');
      q.addData(f.qr, 'Byte');
      q.make();
      const n = q.getModuleCount();
      const size = 660, cell = Math.floor(size / n), real = cell * n;
      const ox = Math.round((W - real) / 2), oy = 330;
      ctx.fillStyle = '#000000';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
    }
    const rows = [['Name', f.name], ['Date of birth', f.showDob ? fmtDate(f.dob) : ''], ['Expires', fmtDate(f.expiration)], ['Provider', f.provider]]
      .filter(r => r[1]);
    let y = 1100;
    for (const [k, v] of rows) {
      ctx.fillStyle = '#5a6b70'; ctx.font = '500 34px ' + font; ctx.fillText(k, 72, y);
      ctx.fillStyle = '#10181b'; fit(ctx, v, 600, 44, font, W - 380 - 60); ctx.fillText(v, 380, y);
      y += 84;
    }
  }

  const api = { readCard, drawCard, parseQr, parseText, segments, fmtDate, toIso };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MedCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
