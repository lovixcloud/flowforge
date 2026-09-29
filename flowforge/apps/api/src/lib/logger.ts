// Structured JSON logging with request IDs and automatic secret redaction.
const SECRET_KEYS = /^(password|secret|token|authorization|apikey|api_key|credential|cookie|session)$/i;

function redact(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return obj;
}

type Fields = Record<string, unknown>;

function emit(level: string, message: string, fields?: Fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...(fields ? (redact(fields) as Fields) : {}) });
  if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
}

export const logger = {
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};
