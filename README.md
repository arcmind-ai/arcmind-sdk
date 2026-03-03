# Arcmind SDK

The open-source analytics SDK for understanding your users and shipping what matters.

**Arcmind** is an AI-powered product analytics platform — auto-instrument your app, get AI-generated hypotheses, and improve conversion. No manual tracking code required.

## Packages

| Package | Description | npm |
| --- | --- | --- |
| [@arcmind/sdk](https://github.com/arcmind-ai/arcmind-sdk) | Lightweight client SDK for web apps | [npm](https://www.npmjs.com/package/@arcmind/sdk) |

## Quickstart

### 1. Install

```bash
npm install @arcmind/sdk
```

### 2. Initialize

```ts
import { Arcmind } from "@arcmind/sdk"

const arcmind = new Arcmind({
  token: "your-project-token",
})
```

### 3. Track events

```ts
arcmind.track("page_view", { path: "/pricing" })
arcmind.track("button_click", { label: "Sign Up" })
```

### 4. Identify users

```ts
arcmind.identify("user-123", { plan: "pro", company: "Acme" })
```

### 5. Cleanup

```ts
// On app teardown — flushes remaining events via beacon
arcmind.destroy()
```

## Features

- **Automatic batching** — events are queued and sent in configurable batches (default: 20)
- **Reliable delivery** — `sendBeacon` + `fetch` keepalive ensure events survive page unloads
- **Retry with backoff** — transient failures are retried with exponential backoff and jitter
- **Payload validation** — event names capped at 256 chars, properties limited to 32KB
- **Zero dependencies** — no runtime dependencies, tree-shakeable ESM + CJS builds
- **Type-safe** — full TypeScript support with exported types

## Configuration

```ts
const arcmind = new Arcmind({
  token: "your-project-token",   // required
  batchSize: 20,                 // events per batch (default: 20)
  flushInterval: 5000,           // auto-flush interval in ms (default: 5000)
  maxQueueSize: 1000,            // max queued events (default: 1000)
})
```

## API

| Method | Signature | Description |
| --- | --- | --- |
| `track` | `(name: string, properties?: Record<string, unknown>) => void` | Track a named event with optional properties |
| `identify` | `(userId: string, traits?: Record<string, unknown>) => void` | Identify the current user with optional traits |
| `flush` | `() => Promise<void>` | Manually flush all queued events |
| `destroy` | `() => void` | Flush via beacon and tear down the client |
| `pendingCount` | `number` (getter) | Number of events currently queued |

## Architecture

```
Your App → @arcmind/sdk → Arcmind Platform → AI Insights
```

- **SDK** (this repo): Open-source. Captures and delivers events from your app.
- **Arcmind Platform**: Managed infrastructure. Ingests events, runs AI analysis, serves the dashboard.

## Framework Support

Works with any JavaScript framework — React, Next.js, Vue, Svelte, Angular, and vanilla JS. Just import and initialize.

## Development

```bash
# Install dependencies
npm install

# Build (ESM + CJS)
npm run build

# Run tests
npm test

# Watch mode
npm run dev
npm run test:watch
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT — see [LICENSE](LICENSE).
