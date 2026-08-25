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
const SENSITIVE_KEY_SOURCE = String.raw`(?:(?:[\p{L}\p{N}]+[_-])+)?(?:token|api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|cookie)`;
const SENSITIVE_QUERY_KEY_SOURCE = `(?:${SENSITIVE_KEY_SOURCE}|x[_-]?amz[_-]?signature|x[_-]?goog[_-]?signature|sig)`;
const SENSITIVE_QUERY_VALUE = new RegExp(`([?&]${SENSITIVE_QUERY_KEY_SOURCE}=)[^&#\\s]*`, "giu");
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
  `(^|[^\\p{L}\\p{N}_-])(${SENSITIVE_KEY_SOURCE}\\s*[:=]\\s*)(?!["']?\\[redacted\\])[^\\s,;{}\\[\\]()]+`,
  "gimu",
);
const PRIVATE_KEY_BLOCK =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/gu;
const URI_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;
const BASIC_CREDENTIAL = /\b(Basic)[ \t]+([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9+/=])/giu;
const SENSITIVE_LONG_OPTION =
  /^--(?:token|api[-_]?key|secret|password|authorization|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?access[-_]?key|private[-_]?key|cookie)$/iu;
const SENSITIVE_LONG_OPTION_ASSIGNMENT =
  /^(--(?:token|api[-_]?key|secret|password|authorization|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?access[-_]?key|private[-_]?key|cookie)=).*$/iu;

/** Redact credential values before optionally bounding the returned text. */
export function redactSensitiveText(text: string, maxChars?: number): string {
  const redacted = text
    .replace(PRIVATE_KEY_BLOCK, "[private key redacted]")
    .replace(URI_USERINFO, "$1[redacted]@")
    .replace(SENSITIVE_ESCAPED_DOUBLE_QUOTED_VALUE, "$1$2[redacted]$3")
    .replace(SENSITIVE_QUERY_VALUE, "$1[redacted]")
    .replace(/\b(Bearer)[ \t]+[^\s"',;`\\]+/giu, "$1 [redacted]")
    .replace(BASIC_CREDENTIAL, (match, scheme: string, credential: string) => {
      try {
        const decoded = Buffer.from(credential, "base64");
        const canonical = decoded.toString("base64").replace(/=+$/u, "");
        return canonical === credential.replace(/=+$/u, "") && decoded.includes(0x3a)
          ? `${scheme} [redacted]`
          : match;
      } catch {
        return match;
      }
    })
    .replace(
      /(^|\r?\n)([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/giu,
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
/** Redact credentials whose CLI option and value occupy separate argv entries. */
export function redactSensitiveArgs(args: readonly string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "[redacted]";
    }
    const redacted = redactSensitiveText(argument).replace(
      SENSITIVE_LONG_OPTION_ASSIGNMENT,
      "$1[redacted]",
    );
    redactNext = SENSITIVE_LONG_OPTION.test(argument);
    return redacted;
  });
}
