# store-flow

Drive an app's **state CLI** from TypeScript flow tests. The CLI exposes the app's stores (the layer right below the UI) over NDJSON on stdin/stdout, so the same scenario file can run against the iOS and the Android build of the app, with no UI involved.

Zero runtime dependencies. Runs on Bun (and Node, since it only uses `node:child_process`).

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
import { launch, platformCommand } from 'store-flow';

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

## Platforms

`platformCommand(root, targets, platform = currentPlatform())` reads `FLOW_PLATFORM=ios|android`:

- **ios** → `swift run [swiftArgs] --package-path <root>/<packagePath> <product>`. The first run builds; raise `readyTimeoutMs` or run `swift build` beforehand.
- **android** → `<root>/<executable>`, the launcher from gradle's `installDist` (e.g. `./gradlew -p android :cli:installDist`).

## Development

```sh
bun install
bun test        # runs against test/fake-cli.ts, a tiny CLI implementing the protocol
bun run typecheck
```
