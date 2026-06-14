# @patriceckhart/zot-sdk-javascript

TypeScript SDK for embedding `zot rpc` in Node.js applications.

The SDK starts a long-lived `zot rpc` child process and talks newline-delimited JSON over stdin/stdout. It is intended for Node-compatible server runtimes. Do not import it in browser components or edge runtimes.

## Install

```bash
npm install @patriceckhart/zot-sdk-javascript
# or
pnpm add @patriceckhart/zot-sdk-javascript
# or
yarn add @patriceckhart/zot-sdk-javascript
# or
bun add @patriceckhart/zot-sdk-javascript
```

During install, `postinstall` detects your OS and CPU. If `zot` is already on `PATH`, it uses that. Otherwise it downloads the matching release asset from GitHub, verifies `checksums.txt`, and stores the binary under the package `vendor/` directory.

Environment controls:

- `ZOT_SKIP_INSTALL=1`: skip binary download.
- `ZOT_FORCE_INSTALL=1`: download even when `zot` exists on `PATH`.
- `ZOT_VERSION=v0.2.31`: pin a zot release tag.
- `ZOT_BINARY=/path/to/zot`: use a specific binary at runtime.

## Node.js usage

```ts
import { ZotClient } from "@patriceckhart/zot-sdk-javascript";

const zot = new ZotClient({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  cwd: process.cwd(),
});

for await (const event of zot.promptStream("Explain this project in 3 bullets")) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "tool_call") console.log("\ntool:", event.name, event.args);
}

zot.close();
```

One-shot prompt:

```ts
import { createZotClient } from "@patriceckhart/zot-sdk-javascript";

const zot = await createZotClient({ provider: "openai", cwd: process.cwd() });
const result = await zot.prompt("Write a tiny README for this app");
console.log(result.text);
zot.close();
```

## Framework usage

`zot rpc` is stateful, so keep one client per chat session on the server. The SDK works in any Node-compatible server framework that can spawn child processes. It does not work in browser code or edge runtimes.

### Next.js route handler example

This minimal example streams text deltas as Server-Sent Events.

```ts
// app/api/chat/route.ts
import { ZotClient } from "@patriceckhart/zot-sdk-javascript";

export const runtime = "nodejs";

const clients = new Map<string, ZotClient>();

function getClient(sessionId: string) {
  let client = clients.get(sessionId);
  if (!client) {
    client = new ZotClient({
      provider: process.env.ZOT_PROVIDER ?? "anthropic",
      model: process.env.ZOT_MODEL,
      cwd: process.cwd(),
    });
    clients.set(sessionId, client);
  }
  return client;
}

export async function POST(req: Request) {
  const { message, sessionId = "default" } = await req.json();
  const client = getClient(sessionId);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of client.promptStream(message)) {
          if (event.type === "text_delta") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: event.delta })}\n\n`));
          }
          if (event.type === "done") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(String(error))}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
```

### Nuxt server route example

```ts
// server/api/chat.post.ts
import { ZotClient } from "@patriceckhart/zot-sdk-javascript";

const zot = new ZotClient({
  provider: process.env.ZOT_PROVIDER ?? "anthropic",
  model: process.env.ZOT_MODEL,
  cwd: process.cwd(),
});

export default defineEventHandler(async (event) => {
  const body = await readBody<{ message: string }>(event);
  const result = await zot.prompt(body.message);
  return { text: result.text };
});
```

## API

```ts
const client = new ZotClient(options);
await client.start();
await client.hello();
await client.ping();
await client.prompt("message");
client.promptStream("message");
await client.abort();
await client.compact();
await client.getState();
await client.getMessages();
await client.clear();
await client.setModel("model-id");
await client.getModels();
client.close();
```

Important options:

- `binary`: path to `zot`. Defaults to `ZOT_BINARY` or `zot`.
- `provider`, `model`, `cwd`, `apiKey`, `baseUrl` map to `zot rpc` flags.
- `systemPrompt`, `appendSystemPrompt`, `reasoning`, `maxSteps`, `noTools`, `tools` map to `zot rpc` flags.
- `rpcToken`: sends the initial `hello` token when `ZOTCORE_RPC_TOKEN` is set on the child process.

## Auth

Use normal zot auth. Run `zot` and `/login`, or pass provider API keys via environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `KIMI_API_KEY`, and others supported by zot.

## Notes

- One `ZotClient` wraps one `zot rpc` process, cwd, model, and session.
- Use it only in Node-compatible server runtimes with child process support.
- Only one prompt or compact operation should be active per client.
- For multiple projects or concurrent chats, create multiple clients.
- The process exits when closed or when stdin closes.

## License

MIT
