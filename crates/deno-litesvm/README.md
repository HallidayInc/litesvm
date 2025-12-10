# LiteSVM (Deno)

Native Deno bindings for [LiteSVM](https://github.com/LiteSVM/litesvm). The bindings are generated with
[`deno_bindgen`](https://github.com/denoland/deno_bindgen) and expose the same fast, in-process Solana
runtime used by the Rust and Node.js packages.

## Usage

1. Generate the bindings (builds the shared library and emits `bindings/litesvm.ts`). The workspace ships a
   patched `deno_bindgen` wrapper to avoid the upstream CLI hang on large outputs:

```bash
cd crates/deno-litesvm
CARGO_TARGET_DIR=../../target \
  cargo run -p deno_bindgen_cli --manifest-path ../deno-bindgen-cli/Cargo.toml -- --out bindings/litesvm.ts
```

2. Import the generated loader and start interacting with LiteSVM from Deno:

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

## Testing the bindings

After building the shared library, you can run the Deno tests that exercise legacy and versioned
transactions end-to-end:

```bash
cd crates/deno-litesvm
CARGO_TARGET_DIR=../../target cargo build -p litesvm-deno
deno test -A mod.test.ts
```

The tests demonstrate constructing transactions with `npm:@solana/web3.js`, signing them, and
driving them through LiteSVM in memory.
