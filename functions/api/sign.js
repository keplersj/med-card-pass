import { signingConfig, json } from '../../src/config.js';
import { signDetached, validManifest } from '../../src/cms.js';

// POST /api/sign: body is a pass's manifest.json (file names and SHA-1 hashes only).
// Returns the detached CMS signature for it. The card's contents never reach this function,
// and nothing is logged or stored.
export async function onRequestPost({ request, env }) {
  const c = signingConfig(env);
  if (!c.on) return json({ error: 'Signing is not set up on this site.' }, 501);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0 || body.length > 4096) return json({ error: 'Bad manifest.' }, 400);
  if (!validManifest(new TextDecoder().decode(body))) return json({ error: 'Bad manifest.' }, 400);
  try {
    const sig = await signDetached(body, {
      certPem: env.PASS_CERT_PEM,
      keyPem: env.PASS_KEY_PEM,
      chainPems: [env.WWDR_CERT_PEM],
    });
    return new Response(sig, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return json({ error: 'Signing failed. Check the certificate and key secrets.' }, 500);
  }
}
