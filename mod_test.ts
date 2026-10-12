import { Wan27, Wan27Error } from "./mod.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
async function rejects(action: () => unknown, code: string) {
  try {
    await action();
  } catch (e) {
    if (e instanceof Wan27Error && e.code === code) return;
    throw e;
  }
  throw new Error(`Expected ${code}`);
}
const input = {
  modelId: "wan27-text-to-video",
  prompt: "Paper boat",
  durationSeconds: 5,
};
const requestId = "12345678-1234-1234-1234-123456789abc";

Deno.test("official routes, trailing slash, credential headers and query encoding", async () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const wan = new Wan27({
    token: () => "fixture-token",
    fetch: async (url, init) => {
      const headers = new Headers(init!.headers);
      equal(headers.get("Authorization"), "Bearer fixture-token");
      equal(headers.get("X-Wan27-Client-Mode"), "cli");
      equal(init!.redirect, "error");
      requests.push({
        url: String(url),
        method: init!.method!,
        body: init!.body ?? null,
      });
      return Response.json({ ok: true });
    },
  });
  await wan.account();
  await wan.models();
  await wan.model("wan2.7-image");
  await wan.estimate(input);
  await wan.tasks({ limit: 5, cursor: "a+b&c" });
  await wan.task("task/id");
  equal(requests.map((r) => r.url), [
    "https://wan2-7.io/api/v1/account/",
    "https://wan2-7.io/api/v1/models/",
    "https://wan2-7.io/api/v1/models/wan2.7-image",
    "https://wan2-7.io/api/v1/estimates/",
    "https://wan2-7.io/api/v1/tasks/?limit=5&cursor=a%2Bb%26c",
    "https://wan2-7.io/api/v1/tasks/task%2Fid/",
  ]);
  equal(requests[3].method, "POST");
  equal(requests[3].body, JSON.stringify(input));
});

Deno.test("generation transmits retained idempotency key once and returns task unchanged", async () => {
  let calls = 0;
  const wan = new Wan27({
    token: "fixture",
    fetch: async (_url, init) => {
      calls++;
      equal(new Headers(init!.headers).get("Idempotency-Key"), requestId);
      return Response.json({ task: { id: "task-1", status: "queued" } });
    },
  });
  equal(await wan.generate(input, requestId), {
    task: { id: "task-1", status: "queued" },
  });
  equal(calls, 1);
});

Deno.test("validation blocks missing auth, bad keys, traversal, limits and oversized bodies before fetch", async () => {
  const noFetch: typeof fetch = () => {
    throw new Error("Must not call fetch");
  };
  const wan = new Wan27({ token: "fixture", fetch: noFetch });
  await rejects(
    () => new Wan27({ token: "", fetch: noFetch }).account(),
    "AUTH_REQUIRED",
  );
  await rejects(
    () => new Wan27({ token: "x\r\ny", fetch: noFetch }).account(),
    "AUTH_REQUIRED",
  );
  await rejects(() => wan.generate(input, "short"), "INVALID_INPUT");
  await rejects(() => wan.model(".."), "INVALID_INPUT");
  await rejects(() => wan.task(""), "INVALID_INPUT");
  await rejects(() => wan.tasks({ limit: 0 }), "INVALID_INPUT");
  await rejects(() => wan.tasks({ limit: 51 }), "INVALID_INPUT");
  await rejects(
    () => wan.estimate({ ...input, prompt: "é".repeat(17000) }),
    "INVALID_INPUT",
  );
  await rejects(
    () => new Wan27({ token: "fixture", timeoutMs: Infinity }),
    "INVALID_INPUT",
  );
});

Deno.test("API errors preserve status and code", async () => {
  const wan = new Wan27({
    token: "fixture",
    fetch: async () =>
      Response.json({
        error: { code: "INSUFFICIENT_CREDITS", message: "Not enough credits" },
      }, { status: 402 }),
  });
  try {
    await wan.estimate(input);
    throw new Error("Expected failure");
  } catch (e) {
    if (!(e instanceof Wan27Error)) throw e;
    equal(e.status, 402);
    equal(e.code, "INSUFFICIENT_CREDITS");
  }
});

Deno.test("ambiguous network failure never retries a paid request or exposes token", async () => {
  let calls = 0;
  const wan = new Wan27({
    token: "fixture-secret",
    fetch: () => {
      calls++;
      throw new Error("fixture-secret");
    },
  });
  await rejects(() => wan.generate(input, requestId), "SERVICE_UNAVAILABLE");
  equal(calls, 1);
});

Deno.test("malformed and oversized responses fail with bounded reader", async () => {
  for (const body of ["<html>error</html>", "[]", "x".repeat(2_097_153)]) {
    const wan = new Wan27({
      token: "fixture",
      fetch: async () => new Response(body),
    });
    await rejects(() => wan.account(), "INVALID_RESPONSE");
  }
});
