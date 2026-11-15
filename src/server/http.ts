import { ApiError } from "./errors";

// Outbound API calls. There is never an automatic retry, so a post can't be sent twice.

const HINTS: Record<string, Record<string, string>> = {
  linkedin: {
    expired: "Your LinkedIn sign-in is expired or invalid. Connect LinkedIn again on the Settings page.",
    permission: "LinkedIn denied this. Check the app has 'Share on LinkedIn' and connect LinkedIn again on the Settings page.",
    version: "LinkedIn no longer serves this API version. Ask your administrator to update LINKEDIN_VERSION (YYYYMM).",
    rate: "LinkedIn's rate limit was reached. Wait and try again later (limits reset daily).",
  },
  facebook: {
    expired: "Your Meta access token is expired or invalid. Save a new one on the Settings page.",
    permission: "Your Meta access token is missing a permission. It needs pages_manage_posts, pages_manage_metadata, pages_read_engagement, pages_show_list, instagram_basic and instagram_content_publish.",
    version: "This Graph API version is retired. Ask your administrator to update META_GRAPH_VERSION.",
    rate: "Meta's rate limit was reached. Wait a while and try again.",
  },
  instagram: {
    expired: "Your Meta access token is expired or invalid. Save a new one on the Settings page.",
    permission: "Your Meta access token is missing instagram_content_publish. Save a token with that permission on the Settings page.",
    version: "This Graph API version is retired. Ask your administrator to update META_GRAPH_VERSION.",
    rate: "Meta's rate limit was reached. Wait a while and try again.",
  },
  gemini: {
    expired: "Check GEMINI_API_KEY on Vercel. Create a key at https://aistudio.google.com/apikey",
    permission: "Check GEMINI_API_KEY on Vercel. Create a key at https://aistudio.google.com/apikey",
    version: "This Gemini lite model is unavailable. Set GEMINI_MODEL on Vercel to a current flash-lite model.",
    rate: "Gemini's rate limit or quota was reached. Wait a minute and try again.",
  },
};

export function classifyFailure(status: number | null, code: unknown, text: string): string | null {
  const lowered = text.toLowerCase();
  const meta = typeof code === "number" ? code : null;
  if (status === 426 || meta === 2635 || lowered.includes("nonexistent_version") || lowered.includes("version_missing")
    || (lowered.includes("version") && /deprecat|no longer|not active|retired|unsupported/.test(lowered))
    || (lowered.includes("model") && status === 404)) return "version";
  if (status === 429 || [4, 17, 32, 613].includes(meta as number) || lowered.includes("rate limit") || lowered.includes("resource_exhausted")) return "rate";
  if (status === 401 || meta === 190 || lowered.includes("expired") || lowered.includes("api key not valid") || lowered.includes("api_key_invalid")) return "expired";
  if (status === 403 || meta === 10 || (meta !== null && meta >= 200 && meta <= 299) || lowered.includes("permission") || lowered.includes("access_denied")) return "permission";
  return null;
}

export interface CallOptions {
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  params?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
}

export async function httpCall(method: string, url: string, service: string, options: CallOptions = {}): Promise<Response> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.params || {})) target.searchParams.set(key, value);
  const headers: Record<string, string> = { ...(options.headers || {}) };
  let body: BodyInit | undefined = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(target, { method, headers, body, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new ApiError(`${service}: timed out waiting for ${target.hostname}.`,
        "Check the platform before retrying: the request may have succeeded.");
    }
    throw new ApiError(`${service}: could not reach ${target.hostname}.`, "Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw await apiErrorFrom(response, service);
  return response;
}

export async function apiErrorFrom(response: Response, service: string): Promise<ApiError> {
  let code: unknown = null;
  let detail = "";
  let extra = "";
  const raw = await response.text().catch(() => "");
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (data && typeof data === "object") {
    const error = data.error;
    if (error && typeof error === "object") {
      code = error.code;
      detail = String(error.message || "");
      extra = String(error.status || "");
      if (error.error_user_msg) detail += ` (${error.error_user_msg})`;
    } else {
      code = data.code || data.serviceErrorCode;
      detail = String(data.message || data.error_description || error || "");
    }
  }
  if (!detail) detail = raw.slice(0, 300);
  const label = `HTTP ${response.status}` + (code !== null && code !== undefined && code !== "" ? `, code ${code}` : "");
  const category = classifyFailure(response.status, code, `${code} ${extra} ${detail}`);
  return new ApiError(`${service}: ${detail.trim()} [${label}]`, category ? HINTS[service]?.[category] : null, response.status);
}

export async function jsonOf(response: Response, service: string): Promise<any> {
  try {
    const data = await response.json();
    if (!data || typeof data !== "object") throw new Error("not an object");
    return data;
  } catch {
    throw new ApiError(`${service}: the API returned a response that is not JSON.`);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
