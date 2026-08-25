/** Remove ANSI escape sequences (CSI style) from a string. */
export function stripAnsi(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001b" && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && !/[A-Za-z]/.test(text[index] as string)) {
        index += 1;
      }
      index += 1;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

/**
 * Remove ANSI escapes and control characters from untrusted text (model
 * outputs, errors, titles) so rendering it cannot alter terminal state. Line
 * breaks and tabs collapse to single spaces because callers interpolate the
 * result into single terminal lines, where a stray newline would break
 * viewport math and allow fake rows.
 */
export function sanitizeText(text: string): string {
  return (
    stripAnsi(text)
      .replaceAll(/[\t\n\r]+/g, " ")
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u0000-\u001f\u007f]/g, "")
  );
}
const SENSITIVE_KEY_SOURCE =
  "(?:token|api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret)";
const SENSITIVE_QUERY_VALUE = new RegExp(`([?&]${SENSITIVE_KEY_SOURCE}=)[^&#\\s]*`, "giu");
const SENSITIVE_DOUBLE_QUOTED_VALUE = new RegExp(
  `((?:["']?${SENSITIVE_KEY_SOURCE}["']?)\\s*[:=]\\s*)"(?:\\\\[\\s\\S]|[^"\\\\])*"`,
  "giu",
);
const SENSITIVE_ESCAPED_DOUBLE_QUOTED_VALUE = new RegExp(
  String.raw`((?:\\+"${SENSITIVE_KEY_SOURCE}\\+")\s*[:=]\s*)(\\+")[\s\S]*?(\\+")`,
  "giu",
);
const SENSITIVE_SINGLE_QUOTED_VALUE = new RegExp(
  `((?:["']?${SENSITIVE_KEY_SOURCE}["']?)\\s*[:=]\\s*)'(?:\\\\[\\s\\S]|[^'\\\\])*'`,
  "giu",
);
const SENSITIVE_UNQUOTED_VALUE = new RegExp(
  `(^|[^\\p{L}\\p{N}_-])(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)[^\\s,;{}\\[\\]()]+`,
  "gimu",
);

/** Redact credential values before optionally bounding the returned text. */
export function redactSensitiveText(text: string, maxChars?: number): string {
  const redacted = text
    .replace(SENSITIVE_ESCAPED_DOUBLE_QUOTED_VALUE, "$1$2[redacted]$3")
    .replace(SENSITIVE_QUERY_VALUE, "$1[redacted]")
    .replace(/\b(Bearer)[ \t]+[^\s"',;`\\]+/giu, "$1 [redacted]")
    .replace(
      /(^|\r?\n)([ \t]*(?:authorization|x-api-key|x-auth-token)\s*:\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/giu,
      "$1$2[redacted]",
    )
    .replace(SENSITIVE_DOUBLE_QUOTED_VALUE, '$1"[redacted]"')
    .replace(SENSITIVE_SINGLE_QUOTED_VALUE, "$1'[redacted]'")
    .replace(SENSITIVE_UNQUOTED_VALUE, "$1$2[redacted]");
  if (maxChars === undefined || redacted.length <= maxChars) return redacted;
  const marker = "… [error truncated]";
  if (maxChars <= marker.length) return marker.slice(0, Math.max(0, maxChars));
  return `${redacted.slice(0, maxChars - marker.length)}${marker}`;
}
