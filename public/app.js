/* Page wiring for Med Card Pass. Everything runs in this tab. */
{
  const $ = id => document.getElementById(id);
  const statusEl = $('status'), out = $('out'), empty = $('empty'), saveBtn = $('save'), passBtn = $('pkpass'), card = $('card');
  const FONT = '"Public Sans", system-ui, sans-serif';
  const fields = ['title', 'id', 'name', 'dob', 'issued', 'expiration', 'provider'];
  let data = null, pngBlob = null, url = '', signing = null, testSigner = null;
  // Used when the site has no Apple certificate: a test pass, signed in this tab.
  const TEST = { passTypeIdentifier: 'pass.dev.medcardpass.test', teamIdentifier: 'MCPTEST000', organizationName: 'Med Card Pass' };

  const say = (msg, bad) => { statusEl.textContent = msg; statusEl.className = 'status' + (bad ? ' bad' : ''); };
  const makeCanvas = (w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  };
  const toBytes = canvas => new Promise((ok, fail) => canvas.toBlob(b => b ? b.arrayBuffer().then(a => ok(new Uint8Array(a)), fail) : fail(new Error('png')), 'image/png'));

  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  function readFields() {
    const f = {};
    for (const k of fields) f[k] = $('f-' + k).value.trim();
    f.showDob = $('f-showdob').checked;
    f.qr = data ? data.qr : '';
    return f;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    const href = URL.createObjectURL(blob);
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  }

  async function render() {
    if (!data || !data.qr) return;
    try { await document.fonts.load('600 44px "Public Sans"'); await document.fonts.load('700 64px "Public Sans"'); } catch (e) {}
    const { canvas, ctx } = makeCanvas(10, 10);
    MedCard.drawCard(ctx, readFields(), qrcode, { font: FONT });
    canvas.toBlob(b => {
      if (!b) return;
      pngBlob = b;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(b);
      out.src = url; out.hidden = false; empty.hidden = true;
      saveBtn.disabled = false;
      passBtn.disabled = false;
    }, 'image/png');
  }

  async function handle(file) {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { say('That file isn’t a PDF. Pick the card PDF.', true); return; }
    if (!window.pdfjsLib || !window.jsQR || !window.MedCard) { say('The page didn’t finish loading. Reload it and try again.', true); return; }
    say('Reading your card…');
    saveBtn.disabled = true; passBtn.disabled = true;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      data = await MedCard.readCard(buf, { pdfjsLib, makeCanvas, jsQR });
    } catch (e) {
      data = null;
      say('I couldn’t open that PDF. If it has a password, save an unlocked copy first.', true);
      return;
    }
    for (const k of ['id', 'name', 'dob', 'issued', 'expiration', 'provider']) $('f-' + k).value = data[k] || '';
    $('qrtext').textContent = data.qr || 'no QR code found';
    if (!data.qr) { say('I couldn’t find a QR code in that PDF. Check that it’s the card itself, not a receipt or letter.', true); return; }
    const missing = ['id', 'name', 'expiration'].filter(k => !data[k]);
    say(missing.length ? 'QR code found. Fill in the empty fields, then save.' : 'Card ready. Check the details, then save.');
    render();
  }

  $('file').addEventListener('change', e => handle(e.target.files[0]));
  $('file2').addEventListener('change', e => { handle(e.target.files[0]); e.target.value = ''; });
  card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag'); });
  card.addEventListener('dragleave', () => card.classList.remove('drag'));
  card.addEventListener('drop', e => { e.preventDefault(); card.classList.remove('drag'); handle(e.dataTransfer.files[0]); });
  for (const k of fields) $('f-' + k).addEventListener('input', render);
  $('f-showdob').addEventListener('change', render);

  saveBtn.addEventListener('click', () => {
    if (!pngBlob) return;
    download(pngBlob, 'med-card-wallet.png');
    say('Saved. In Google Wallet, add it with Photo.');
  });

  async function testSign(manifest) {
    if (!testSigner) {
      const cms = await import('./vendor/cms.js');
      const { certDer, key } = await cms.makeSelfSigned(TEST);
      testSigner = m => cms.signDetachedWith(m, { certDer, key });
    }
    return testSigner(manifest);
  }

  async function serverSign(manifest) {
    const r = await fetch('api/sign', { method: 'POST', body: manifest, headers: { 'content-type': 'application/json' } });
    if (!r.ok) throw new Error('sign ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  async function makePass(unsigned) {
    if (!data || !data.qr) return;
    passBtn.disabled = true;
    say('Making your pass…');
    try {
      const cfg = signing || TEST;
      const sign = unsigned ? null : signing ? serverSign : testSign;
      const bytes = await MedPass.buildPkpass(readFields(), cfg, { makeCanvas, toBytes, sign, JSZip });
      download(new Blob([bytes], { type: 'application/vnd.apple.pkpass' }), unsigned ? 'med-card-unsigned.pkpass' : 'med-card.pkpass');
      say('Pass downloaded. Open it and choose your wallet.');
    } catch (e) {
      say('I couldn’t make the pass just now. The card image still works for Google Wallet.', true);
    } finally {
      passBtn.disabled = false;
    }
  }

  passBtn.addEventListener('click', () => makePass(false));
  $('unsigned').addEventListener('click', e => { e.preventDefault(); makePass(true); });

  // Ask the site whether pass signing is set up. A plain static copy has no /api, which is fine.
  fetch('api/config', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(c => {
      if (!c || !c.signing) return;
      signing = { passTypeIdentifier: c.passTypeIdentifier, teamIdentifier: c.teamIdentifier, organizationName: c.organizationName };
      $('applenote').hidden = false; $('nosign').hidden = true; $('testnote').hidden = true;
    })
    .catch(() => {});
}
