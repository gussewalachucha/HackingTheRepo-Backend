// Secret redaction for anything that can reach a log entry, an errorMessage
// saved to MongoDB, or the server console.

const MASK = "***";

// Generic patterns, applied to every string regardless of the known secrets.
const GENERIC_PATTERNS = [
  // Classic GitHub tokens (personal, OAuth, user-to-server, server-to-server, refresh)
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, MASK],
  // Fine-grained personal access tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, MASK],
  // Groq API keys
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, MASK],
  // Authorization headers (git extraheader, HTTP clients)
  [/(authorization:\s*(?:basic|bearer|token)\s+)[^\s"'`]+/gi, `$1${MASK}`],
  // Credentials embedded in URLs: https://user:secret@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
];

export function scrubSecrets(text) {
  let out = text === undefined || text === null ? "" : String(text);
  for (const [pattern, replacement] of GENERIC_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function replaceAll(text, needle, replacement) {
  if (!needle) return text;
  return text.split(needle).join(replacement);
}

/**
 * Build a redactor for one job. `secrets` are masked together with the
 * encodings in which they can show up (the base64 form used in the git
 * AUTHORIZATION header, plain base64, URL-encoding). `paths` are replaced
 * with a placeholder so server directories never reach users or the LLM.
 */
export function createRedactor(secrets = [], { paths = [] } = {}) {
  const needles = new Set();
  for (const secret of secrets) {
    if (!secret || typeof secret !== "string" || secret.length < 4) continue;
    needles.add(secret);
    needles.add(Buffer.from(`x-access-token:${secret}`).toString("base64"));
    needles.add(Buffer.from(secret).toString("base64"));
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) needles.add(encoded);
  }
  // Longest first so a secret that contains another one is masked whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);

  const pathNeedles = [];
  for (const { value, replacement } of paths) {
    if (!value) continue;
    const variants = new Set([value, value.replace(/\\/g, "/")]);
    for (const variant of variants) pathNeedles.push([variant, replacement]);
  }
  pathNeedles.sort((a, b) => b[0].length - a[0].length);

  return function redact(text) {
    let out = text === undefined || text === null ? "" : String(text);
    for (const needle of ordered) out = replaceAll(out, needle, MASK);
    for (const [needle, replacement] of pathNeedles) {
      out = replaceAll(out, needle, replacement);
    }
    return scrubSecrets(out);
  };
}
