// Signing is optional. It turns on only when all of these are set on the Pages project:
//   PASS_TYPE_ID, TEAM_ID, ORG_NAME            (plain variables)
//   PASS_CERT_PEM, PASS_KEY_PEM, WWDR_CERT_PEM (secrets)
export function signingConfig(env) {
  const need = ['PASS_TYPE_ID', 'TEAM_ID', 'PASS_CERT_PEM', 'PASS_KEY_PEM', 'WWDR_CERT_PEM'];
  const on = need.every(k => typeof env[k] === 'string' && env[k].trim());
  return {
    on,
    passTypeIdentifier: on ? env.PASS_TYPE_ID.trim() : null,
    teamIdentifier: on ? env.TEAM_ID.trim() : null,
    organizationName: (env.ORG_NAME || 'Med Card Pass').trim(),
  };
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
