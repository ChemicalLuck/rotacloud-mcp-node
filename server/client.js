const BASE_URL = "https://api.rotacloud.com/v1";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class RotaCloudError extends Error {
  constructor(status, statusText, body, url) {
    const apiMessage = body && typeof body === "object" ? body.error : undefined;
    super(apiMessage || `HTTP ${status} ${statusText}`);
    this.name = "RotaCloudError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.detail = `RotaCloud API error ${status}: ${apiMessage || statusText}`;
  }
}

// Link: <https://…?offset=20>; rel="next", <…>; rel="last"
function parseLinkHeader(header) {
  if (!header) return undefined;
  const links = {};
  for (const part of header.split(/,\s*(?=<)/)) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return Object.keys(links).length ? links : undefined;
}

function buildQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    // RotaCloud repeats the key for array parameters, e.g. users=1&users=2
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function fillPath(path, params) {
  return path.replace(/\{(\w+)\}/g, (_, name) => {
    const value = params?.[name];
    if (value === undefined || value === null) throw new Error(`Missing required path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RotaCloud {
  constructor(apiKey = process.env.ROTACLOUD_API_KEY, defaultUserId = process.env.ROTACLOUD_USER_ID) {
    if (!apiKey) throw new Error("ROTACLOUD_API_KEY is not set. Generate an API key from your RotaCloud account.");
    this.apiKey = apiKey;
    this.defaultUserId = defaultUserId || undefined;
  }

  async request(method, path, { pathParams, query, body, asUser } = {}) {
    const url = BASE_URL + fillPath(path, pathParams) + buildQuery(query);

    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    const user = asUser ?? this.defaultUserId;
    if (user !== undefined) headers.User = String(user);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    // Retry state is local to the call — a shared counter would be a concurrency bug.
    let attempt = 0;
    for (;;) {
      // A body must still be sent on DELETE: /attendance_approved, /days_off,
      // /shifts_published and /users_clocked_in/{id} all require one.
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * 2 ** attempt;
        attempt += 1;
        await sleep(delay);
        continue;
      }

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) throw new RotaCloudError(response.status, response.statusText, data, url);

      const totalCountHeader = response.headers.get("x-total-count");
      return {
        data,
        totalCount: totalCountHeader === null ? undefined : Number(totalCountHeader),
        links: parseLinkHeader(response.headers.get("link")),
      };
    }
  }
}
