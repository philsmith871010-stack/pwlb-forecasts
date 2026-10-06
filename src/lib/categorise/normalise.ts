// Narrative normalisation. `clean` keeps the words; `signature` is the grouping key used
// for rules, review queues and recurrence detection (reference numbers removed).

const ENCODING_JUNK = /Â|â€™|â€˜|â€œ|â€\u009d|â€“|â€”| |[‘’“”]/g;
const DATE_LIKE = /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;

export function cleanNarrative(raw: string): string {
  return raw
    .replace(ENCODING_JUNK, ' ')
    .toUpperCase()
    .replace(/£/g, ' ')
    .replace(/[^A-Z0-9&/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Signature: dates and standalone numbers removed; digit runs inside tokens become '#';
 * slash references keep their alpha prefix (FD/23/114 → FD/#/#).
 */
export function signatureOf(clean: string): string {
  const s = clean.replace(DATE_LIKE, ' ');
  const out: string[] = [];
  for (const tok of s.split(' ')) {
    if (!tok) continue;
    if (/^\d+$/.test(tok)) continue; // standalone reference numbers
    if (tok.includes('/')) {
      const parts = tok.split('/').map((p) => (/^\d+$/.test(p) ? '#' : p.replace(/\d+/g, '#')));
      const t = parts.join('/');
      if (t.replace(/[#/]/g, '')) out.push(t);
      else out.push('#/#');
      continue;
    }
    if (/\d/.test(tok)) {
      // tokens carrying 4+ digits are references (TX3624977004, FD53036683) — drop them
      if ((tok.match(/\d/g) ?? []).length >= 4) continue;
      const t = tok.replace(/\d+/g, '#');
      out.push(t);
      continue;
    }
    if (tok === '&') { out.push('AND'); continue; }
    out.push(tok);
  }
  // collapse runs of '#'-only tokens
  const res: string[] = [];
  for (const t of out) {
    if (/^[#/]+$/.test(t) && res.length && /^[#/]+$/.test(res[res.length - 1])) continue;
    res.push(t);
  }
  return res.join(' ') || '(NO NARRATIVE)';
}

export function normalise(raw: string): { clean: string; signature: string } {
  const clean = cleanNarrative(raw);
  return { clean, signature: signatureOf(clean) };
}

/** Normalise an account identifier ("'40118830", "40118830 Payroll Account") to a stable key. */
export function normaliseAccount(raw: string): string {
  const s = raw.replace(/^'/, '').trim();
  const num = /\b\d{6,10}\b/.exec(s)?.[0];
  return num ?? s.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
