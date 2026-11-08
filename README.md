# headless-flow

Drive an app's **state CLI** from TypeScript flow tests. The CLI exposes the app's stores (the layer right below the UI) over NDJSON on stdin/stdout, so the same scenario file can run against the iOS and the Android build of the app, with no UI involved.

It can also connect to a running app (a DEBUG build serving the same protocol on a local port) and drive it the same way.

Zero runtime dependencies. Runs on Bun (and Node, since it only uses `node:child_process` and `node:net`).

## Protocol (version 1)

One JSON object per line. The CLI prints `{"ready":true,"protocol":1}` first, then answers each request with the same `id`. Logs go to stderr only.

```json
{"id":1,"cmd":"ls"}
{"id":2,"cmd":"get","store":"home"}
{"id":3,"cmd":"do","store":"home","op":"achieve","args":{"habitId":"h1"}}
{"id":4,"cmd":"quit"}
```

Answers are `{"id":n,"ok":true,"result":...}` or `{"id":n,"ok":false,"error":{"code":"...","message":"..."}}` with code `bad_request` | `unknown_store` | `unknown_op` | `bad_args` | `op_failed`. `do` answers after the operation finished, with the store's state after it (`{"name","state"}`).

## API

```ts
import { launch, platformCommand } from 'headless-flow';

const app = await launch({
  command: platformCommand(repoRoot, {
    ios: { packagePath: 'ios/Packages/CLI', product: 'my-cli' },
    android: { executable: 'android/cli/build/install/cli/bin/cli' },
  }),
  args: ['--api-base', url],
});

await app.ls();                                   // { protocol, stores: [{ name, state, operations }] }
await app.get('home');                            // state
await app.do('home', 'achieve', { habitId: 'h1' }); // state after the op
await app.until('home', (s) => s.habits.length === 1, { timeoutMs: 5000, intervalMs: 50 });
await app.close();                                // sends quit; kills after a timeout
```

- `launch({ command, args?, env?, cwd?, readyTimeoutMs?, requestTimeoutMs?, onStderr? })` spawns the CLI and resolves after the ready line. Non-JSON lines before ready (e.g. `swift run` build output) are tolerated; after ready, anything that is not a response is fatal.
- Calls can run concurrently; answers are matched by id.
- `get`, `do` and `until` take a state type: `app.get<HomeState>('home')`.
- `until` treats a throwing predicate as "not yet", so `expect(...)` works inside it. On timeout it throws `UntilTimeoutError` with the last state seen.
- Errors: `ProtocolError` (`.code`, the CLI said `ok:false`), `ProcessError` (`.stderr`, the CLI failed to start, died or broke the protocol), `UntilTimeoutError` (`.lastState`). All extend `FlowError`.
- `App` implements `Symbol.asyncDispose`, so `await using app = await launch(...)` closes it.

### Connecting to a running app

```ts
import { connect } from 'headless-flow';

// e.g. the simulator app launched with: xcrun simctl launch booted <bundle-id> -HeadlessPort 9500
const app = await connect({ port: 9500 });   // host defaults to 127.0.0.1
await app.get('home');
await app.close();                            // disconnects only; the app keeps running
```

- `connect({ port, host = '127.0.0.1', readyTimeoutMs = 10000, requestTimeoutMs? })` opens a TCP connection and resolves after the ready line the app sends on connect. It returns the same `App` (`ls` / `get` / `do` / `until` / `close`).
- `close()` does not send `quit`; it just disconnects. `pid` is `undefined`.
- A refused connection, a missing ready line or the app dropping the connection all surface as `ProcessError`.
- On the Swift side, `HeadlessSocketServer` in [swift-headless](https://github.com/no-problem-dev/swift-headless) (0.2.0+) serves this.

## Platforms

`platformCommand(root, targets, platform = currentPlatform())` reads `FLOW_PLATFORM=ios|android`:

- **ios** → `swift run [swiftArgs] --package-path <root>/<packagePath> <product>`. The first run builds; raise `readyTimeoutMs` or run `swift build` beforehand.
- **android** → `<root>/<executable>`, the launcher from gradle's `installDist` (e.g. `./gradlew -p android :cli:installDist`).

## Development

```sh
bun install
bun test        # runs against test/fake-cli.ts and test/fake-socket-server.ts, tiny implementations of the protocol
bun run typecheck
```
