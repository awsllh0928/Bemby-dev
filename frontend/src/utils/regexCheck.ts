/**
 * Whether a pattern typed into a form compiles, `/pattern/flags` included -- the same forms
 * the backend accepts for an autoreg code regex. Checked here so a typo is caught while the
 * operator is still looking at the field, rather than at the first message the job scans.
 */
export function regexValid(pattern: string): boolean {
  const text = pattern.trim();
  if (!text) return false;
  const delimited = text.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    new RegExp(delimited ? delimited[1] : text, delimited ? delimited[2] : "");
    return true;
  } catch {
    return false;
  }
}
