import { signingConfig, json } from '../../src/config.js';

// GET /api/config: tells the page whether .pkpass signing is available,
// and the identifiers the pass.json must carry.
export function onRequestGet({ env }) {
  const c = signingConfig(env);
  return json({
    signing: c.on,
    passTypeIdentifier: c.passTypeIdentifier,
    teamIdentifier: c.teamIdentifier,
    organizationName: c.organizationName,
  });
}
