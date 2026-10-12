# Wan27 JavaScript / TypeScript client

A small, dependency-free server-side SDK for [Wan27](https://wan2-7.io/), an AI
image and video generation service. Discover models, read input schemas,
estimate credits, create tasks and retrieve their results from Node.js 22+, Deno
or other server runtimes with standard Fetch APIs.

**The SDK is MIT licensed. The hosted API requires an active paid Wan27
subscription, and generation spends credits.** A credit pack alone does not
enable API access. This is the Wan27 service client, not an Alibaba model-weight
distribution.

## Usage

Install from JSR:

```sh
npx jsr add @notusinggithub/wan27
# Deno: deno add jsr:@notusinggithub/wan27
```

```ts
import { Wan27 } from "@notusinggithub/wan27";

// Server-side only: supply an existing access token from your secret store.
const wan = new Wan27({ token: process.env.WAN27_ACCESS_TOKEN! });
console.log(await wan.account());
console.log(await wan.model("wan27-text-to-video"));

const input = {
  modelId: "wan27-text-to-video",
  prompt: "A paper boat drifting through a rain puddle, gentle tracking shot",
  durationSeconds: 5,
  resolution: "720p",
};
console.log(await wan.estimate(input));

// Only after the user authorizes the estimated spend:
const requestId = crypto.randomUUID(); // persist before submission
const result = await wan.generate(input, requestId);
console.log(result);
// Creation returns task.id; retrieve it with wan.task(taskId).
```

Use the current schema returned by `model()` instead of assuming options or
pricing. API methods return the service's JSON object unchanged. `Wan27Error`
exposes `code` and HTTP `status`.

There are no automatic paid retries. Retain the request ID and input; if a
request times out, inspect `tasks()` and reuse the same request ID for any
retry. Poll `task()` with a bounded wait. `queued` or `processing` does not mean
completion. Do not retry a failed generation as a new paid task without
authorization.

The SDK intentionally does not read the CLI's credential vault or perform
browser login. Use the [CLI](https://wan2-7.io/cli/) for interactive
authentication and uploads, or configure an existing access token in your server
environment. Never put tokens in browser bundles, public repositories or
workflow exports. Requests only target `https://wan2-7.io`, have a 120-second
deadline by default, and reject redirects.

## Development

```sh
deno task check
deno task test
deno publish --dry-run
```

Tests use in-memory responses with networking denied and perform no paid
generations. Live authenticated generation has not been exercised by this
package's test suite.

[Website](https://wan2-7.io/) ·
[MCP and API workflow guide](https://wan2-7.io/mcp/guide/) ·
[Pricing](https://wan2-7.io/pricing/) ·
[Source](https://github.com/NotUsingGithub/wan27-js)
