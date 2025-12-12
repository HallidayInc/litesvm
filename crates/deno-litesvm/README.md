# LiteSVM (Deno)

Native Deno bindings for [LiteSVM](https://github.com/LiteSVM/litesvm). The bindings are generated with
[`deno_bindgen`](https://github.com/denoland/deno_bindgen) and expose the same fast, in-process Solana
runtime used by the Rust and Node.js packages.

## Usage

1. Build the shared library for the bindings (the loader is inlined into `mod.ts`):

```bash
cd crates/deno-litesvm
make build
```

2. Import the loader and start interacting with LiteSVM from Deno:

```ts
import { LiteSvm } from "./mod.ts";

const svm = new LiteSvm();
const payer = crypto.getRandomValues(new Uint8Array(64));
// create and serialize a transaction using @solana/web3.js (npm: @solana/web3.js)
 const result = await svm.sendLegacyTransaction(serializedTxBytes);
 console.log(result);
```

The TypeScript wrapper in `mod.ts` keeps the Rust handles alive and provides ergonomic helpers for
loading default programs, simulating transactions, and inspecting accounts.

If you want a higher-level abstraction that can swap between the in-process LiteSVM fork and a
remote Solana RPC endpoint, use the `SolanaLikeClient` in `client.ts`:

```ts
import { SolanaLikeClient } from "./client.ts";

// In-process fork
const local = SolanaLikeClient.local();
// Remote RPC (uses JSON-RPC over HTTP)
const rpc = SolanaLikeClient.rpc("http://127.0.0.1:8899");
```

## Testing the bindings

After building the shared library, you can run the Deno tests that exercise legacy and versioned
transactions end-to-end:

```bash
cd crates/deno-litesvm
make test
```

The tests demonstrate constructing transactions with `npm:@solana/web3.js`, signing them, and
driving them through LiteSVM in memory.
