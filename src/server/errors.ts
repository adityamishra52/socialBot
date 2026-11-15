// Expected failures carry a hint telling the user how to fix them. Secrets never reach a message.

const REDACTED = "***REDACTED***";
const secrets = new Set<string>();

const PATTERNS: [RegExp, (m: string, ...g: string[]) => string][] = [
  [/\b(access_token|input_token|fb_exchange_token|client_secret|api_secret|api_key|key|signature|appsecret_proof)=[^&\s"']+/gi, (_m, name) => `${name}=${REDACTED}`],
  [/("(?:access_token|input_token|client_secret|api_secret|api_key)"\s*:\s*")[^"]*(")/gi, (_m, a, b) => `${a}${REDACTED}${b}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=|-]+/g, () => `Bearer ${REDACTED}`],
];

/** Remember a secret so redact() removes it from any text. Never register the short admin PIN. */
export function registerSecret(value: string | null | undefined) {
  if (value && value.length >= 6) secrets.add(value);
}

export function redact(text: unknown): string {
  let result = String(text ?? "");
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join(REDACTED);
  for (const [pattern, swap] of PATTERNS) result = result.replace(pattern, swap as any);
  return result;
}

export class AppError extends Error {
  hint?: string | null;
  status?: number | null;
  httpStatus = 502;
  constructor(message: string, hint?: string | null, status?: number | null) {
    super(redact(message));
    this.hint = hint ? redact(hint) : null;
    this.status = status ?? null;
  }
}

/** Settings missing or input invalid: shown to the user as a 400. */
export class ConfigError extends AppError {
  httpStatus = 400;
}

/** A remote service failed. */
export class ApiError extends AppError {}

/** Gemini didn't return something usable. */
export class GenerationError extends AppError {}

/** Gemini refused the prompt: asking again won't help. */
export class PromptBlockedError extends GenerationError {}

export class HttpError extends AppError {
  constructor(httpStatus: number, message: string, hint?: string) {
    super(message, hint);
    this.httpStatus = httpStatus;
  }
}
