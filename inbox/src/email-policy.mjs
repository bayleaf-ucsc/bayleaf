// Creation-only policy, validated independently of the API facade's schema.
export const RESTRICTED_EMAIL_MAX_BYTES = 1048576;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const SLABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const SELECTOR = new RegExp(`^${SLABEL}(?:\\.${SLABEL})*$`);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeEmailAuth(value) {
  if (value === undefined || value === null) return null;
  if (!record(value) || Object.keys(value).some(k => !['domains', 'selector_pins'].includes(k)) ||
      !Array.isArray(value.domains) || value.domains.length < 1 || value.domains.length > 8) throw new Error('email_auth');
  const domains = value.domains.map(d => {
    if (typeof d !== 'string' || d.length > 253 || !DOMAIN.test(d.toLowerCase())) throw new Error('email_auth domain');
    return d.toLowerCase();
  });
  if (new Set(domains).size !== domains.length) throw new Error('duplicate domain');
  const selector_pins = {};
  if (value.selector_pins !== undefined) {
    if (!record(value.selector_pins) || Object.keys(value.selector_pins).length > 8) throw new Error('selector_pins');
    for (const [domain, pins] of Object.entries(value.selector_pins)) {
      const d = domain.toLowerCase();
      if (!domains.includes(d) || Object.hasOwn(selector_pins, d) || !Array.isArray(pins) || pins.length < 1 || pins.length > 4) {
        throw new Error('selector pin domain');
      }
      selector_pins[d] = pins.map(s => {
        if (typeof s !== 'string' || !SELECTOR.test(s.toLowerCase()) || s.length + d.length + 12 > 253) throw new Error('selector');
        return s.toLowerCase();
      });
      if (new Set(selector_pins[d]).size !== pins.length) throw new Error('duplicate selector');
    }
  }
  return { domains, selector_pins };
}
