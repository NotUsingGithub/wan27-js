/**
 * A dependency-free, server-side client for the Wan27 image/video API.
 * API access requires an active paid subscription at https://wan2-7.io/.
 * @module
 */

/** JSON values accepted by the service. */
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};
/** API object; current model schemas are returned by `model()`. */
export type ApiObject = { [key: string]: Json };
/** Provider-specific generation parameters, including a model ID and prompt. */
export type GenerationInput = ApiObject & { modelId: string; prompt: string };

/** An API or client-validation error. Network errors never expose credentials. */
export class Wan27Error extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "Wan27Error";
    this.code = code;
    this.status = status;
  }
}

/** Fetch-compatible transport; injectable for offline tests. */
export type Wan27Fetch = (input: URL, init: RequestInit) => Promise<Response>;

/** Client settings. Keep tokens in a server-side secret store, never browser code. */
export interface Wan27Options {
  /** An existing Wan27 API access token, or a callback that supplies one. */
  token: string | (() => string | Promise<string>);
  /** Optional fetch implementation for tests or a server-side runtime. */
  fetch?: Wan27Fetch;
  /** Request deadline in milliseconds, from 1 to 120000. Default 120000. */
  timeoutMs?: number;
}

function object(value: unknown): value is ApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segment(value: string): string {
  if (!value || value === "." || value === ".." || /[\x00-\x1f]/.test(value)) {
    throw new Wan27Error(
      "INVALID_INPUT",
      "A nonempty model or task ID is required.",
    );
  }
  return encodeURIComponent(value);
}

async function readObject(response: Response): Promise<ApiObject> {
  if (response.status === 204) return {};
  if (!response.body) {
    throw new Wan27Error(
      "INVALID_RESPONSE",
      "Empty API response.",
      response.status,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_097_152) throw new Error("Response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!object(result)) throw new Error("Expected JSON object");
    return result;
  } catch {
    throw new Wan27Error(
      "INVALID_RESPONSE",
      "Unreadable or oversized API response.",
      response.status,
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Wan27 account, model, estimate and generation operations.
 * All calls use the official HTTPS origin and reject redirects.
 * No automatic generation retries or background polling occur.
 */
export class Wan27 {
  #token: Wan27Options["token"];
  #fetch: Wan27Fetch;
  #timeout: number;

  constructor(options: Wan27Options) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMs ?? 120_000;
    if (
      !Number.isInteger(this.#timeout) || this.#timeout < 1 ||
      this.#timeout > 120_000
    ) {
      throw new Wan27Error(
        "INVALID_INPUT",
        "timeoutMs must be between 1 and 120000.",
      );
    }
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    body?: ApiObject,
    key?: string,
  ): Promise<ApiObject> {
    const token = typeof this.#token === "function"
      ? await this.#token()
      : this.#token;
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) {
      throw new Wan27Error(
        "AUTH_REQUIRED",
        "Provide a valid Wan27 access token.",
      );
    }
    let payload: string | undefined;
    if (body !== undefined) {
      try {
        payload = JSON.stringify(body);
      } catch {
        throw new Wan27Error(
          "INVALID_INPUT",
          "Input must be JSON serializable.",
        );
      }
      if (new TextEncoder().encode(payload).byteLength > 32_768) {
        throw new Wan27Error("INVALID_INPUT", "Request exceeds 32 KiB.");
      }
    }
    const url = new URL(`/api/v1/${path}`, "https://wan2-7.io");
    // The service uses trailingSlash; avoid redirecting a request bearing a token.
    if (
      !url.pathname.endsWith("/") &&
      !url.pathname.split("/").at(-1)!.includes(".")
    ) url.pathname += "/";
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        body: payload,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.#timeout),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "X-Wan27-Client-Mode": "cli",
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
      });
    } catch {
      throw new Wan27Error(
        "SERVICE_UNAVAILABLE",
        "Could not reach Wan27; a generation may still have been accepted. Inspect tasks before retrying with the same request ID.",
      );
    }
    const data = await readObject(response);
    if (!response.ok) {
      const error = object(data.error) ? data.error : {};
      throw new Wan27Error(
        typeof error.code === "string" ? error.code : "API_ERROR",
        typeof error.message === "string"
          ? error.message
          : `Wan27 returned HTTP ${response.status}.`,
        response.status,
      );
    }
    return data;
  }

  /** Read subscription access and available credit balance. */
  account(): Promise<ApiObject> {
    return this.#call("GET", "account");
  }
  /** Discover the models currently available through the API. */
  models(): Promise<ApiObject> {
    return this.#call("GET", "models");
  }
  /** Read a model's supported input schema before constructing a request. */
  model(modelId: string): Promise<ApiObject> {
    return this.#call("GET", `models/${segment(modelId)}`);
  }
  /** Estimate a generation's credit cost without creating it. */
  estimate(input: GenerationInput): Promise<ApiObject> {
    return this.#call("POST", "estimates", input);
  }
  /**
   * Create one authorized paid generation. A request ID is mandatory: retain
   * it with the input and reuse it after an ambiguous network result.
   * This method deliberately does not retry or wait automatically.
   */
  generate(input: GenerationInput, requestId: string): Promise<ApiObject> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
      throw new Wan27Error(
        "INVALID_INPUT",
        "requestId must contain 16–128 letters, digits, underscores or hyphens.",
      );
    }
    return this.#call("POST", "generations", input, requestId);
  }
  /** Read recent tasks. An ambiguous submission is not proof of failure. */
  tasks(options: { limit?: number; cursor?: string } = {}): Promise<ApiObject> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Wan27Error("INVALID_INPUT", "limit must be between 1 and 50.");
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.cursor) query.set("cursor", options.cursor);
    return this.#call("GET", `tasks?${query}`);
  }
  /** Get one task; only a succeeded status is a completed generation. */
  task(taskId: string): Promise<ApiObject> {
    return this.#call("GET", `tasks/${segment(taskId)}`);
  }
}
