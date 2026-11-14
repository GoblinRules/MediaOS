const keys = '[\\w.-]*(?:token|secret|password|passwd|api[_-]?key|psk|private-?key|preshared-?key)[\\w.-]*|Authorization|pw'
const secretKey = new RegExp(keys, 'i')
const jsonSecret = /("(?:\\.|[^"\\])*")(\s*:\s*)"(?:\\.|[^"\\])*"/g
const querySecret = /([?&])([^=&#\s"']+)=([^&#\s"']*)/g
const headerSecret = new RegExp(`(\\b(?:${keys})\\s*:\\s*)([^\\r\\n]+)`, 'gi')
const assignment = new RegExp(`(\\b(?:${keys})\\s*=\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,;&]+)`, 'gi')

export function isSecretKey(key: string): boolean { return secretKey.test(key) }

export function redact(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s<>"']+/gi, scrubUrl)
    .replace(jsonSecret, (match: string, key: string, separator: string) =>
      sensitiveJsonKey(key) ? `${key}${separator}"[REDACTED]"` : match)
    .replace(querySecret, (match: string, separator: string, key: string) =>
      secretKey.test(key) ? `${separator}${key}=[REDACTED]` : match)
    .replace(headerSecret, '$1[REDACTED]')
    .replace(assignment, '$1[REDACTED]')
    .replace(/\b(code=)\d+/gi, '$1[REDACTED]')
    .replace(/([=:]\s*)[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g, '$1[REDACTED]')
}

function sensitiveJsonKey(key: string): boolean {
  // Log messages may contain damaged JSON; redaction must still work without throwing.
  try { return secretKey.test(JSON.parse(key) as string) } catch { return secretKey.test(key) }
}

export function redactUrl(url: string): string {
  return redact(scrubUrl(url))
}

function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '[REDACTED]'
    for (const key of parsed.searchParams.keys()) {
      if (secretKey.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    return parsed.toString()
  } catch { return url }
}
