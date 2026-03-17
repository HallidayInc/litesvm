/**
 * Token swap tests using Jupiter V6 on a forked Solana mainnet chain.
 * Tests: USDC→SOL, SOL→USDC, USDT→USDC
 *
 * Requires a mainnet RPC endpoint:
 *   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com" deno test --allow-net --allow-env --allow-ffi --allow-read swap.test.ts
 */

import { assert, assertEquals } from "jsr:@std/assert";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  encodeBase58,
  getAssociatedTokenAddress,
} from "./solana.ts";
import { TransactionResultEnvelope } from "./mod.ts";
import { LocalClient } from "./client.ts";
import { KNOWN_MINTS } from "./utils.ts";
import {
  parseV0Transaction,
  extractAltAddresses,
  parseAltAccount,
  resolveAllAccounts,
  replaceBlockhash,
  signRawV0Transaction,
  type ParsedV0Transaction,
} from "./v0_parser.ts";
import { getJupiterQuote, getJupiterSwapTransaction } from "./jupiter.ts";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fetch a single account from RPC (direct JSON-RPC call).
 * Returns the raw account data as Uint8Array and the account info,
 * or null if the account doesn't exist.
 */
async function fetchRpcAccount(
  rpcEndpoint: string,
  pubkey: PublicKey,
): Promise<{
  data: Uint8Array;
  lamports: number;
  owner: Uint8Array;
  executable: boolean;
  rentEpoch: number;
} | null> {
  const res = await fetch(rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "getAccountInfo",
      params: [pubkey.toBase58(), { encoding: "base64" }],
    }),
  });
  const json = await res.json();
  const value = json.result?.value;
  if (!value) return null;

  // Decode base64 account data
  const [base64Data, _encoding] = value.data;
  const binary = atob(base64Data);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    data[i] = binary.charCodeAt(i);
  }

  // Cap rent_epoch to safe value
  const rawRentEpoch = value.rentEpoch ?? 0;
  const rentEpoch = rawRentEpoch > Number.MAX_SAFE_INTEGER ? 0 : rawRentEpoch;

  return {
    data,
    lamports: value.lamports,
    owner: new PublicKey(value.owner).toBytes(),
    executable: value.executable,
    rentEpoch,
  };
}

/**
 * Execute a Jupiter swap on a forked mainnet chain.
 *
 * Flow:
 * 1. Get Jupiter quote + swap transaction
 * 2. Parse V0 transaction bytes
 * 3. Resolve ALTs and load all accounts into SVM
 * 4. Replace blockhash with local SVM's blockhash
 * 5. Re-sign with test keypair
 * 6. Send raw bytes to SVM
 */
async function executeJupiterSwap(opts: {
  rpcEndpoint: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  swapper: Keypair;
  client: LocalClient;
  /** Maximum retry attempts — Jupiter routes are non-deterministic so
   *  retrying often picks a different (working) route. Default: 3 */
  maxRetries?: number;
}): Promise<{
  result: TransactionResultEnvelope;
  quote: { inAmount: string; outAmount: string };
}> {
  const { rpcEndpoint, inputMint, outputMint, amountIn, swapper, client } = opts;
  const maxRetries = opts.maxRetries ?? 3;
  const svm = client.svm;

  // Warp SVM slot to current mainnet slot once (needed for ALT lookups).
  // The Solana runtime checks `last_extended_slot < current_slot` to decide
  // if all ALT addresses are visible. Without warping, the SVM sits at slot ~1
  // which is far below any mainnet ALT's `last_extended_slot`, causing
  // InvalidAddressLookupTableIndex errors.
  const slotRes = await fetch(rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "getSlot",
      params: [{ commitment: "finalized" }],
    }),
  });
  const slotJson = await slotRes.json();
  const currentMainnetSlot = slotJson.result as number;
  svm.warpToSlot(currentMainnetSlot);
  console.log(`  Warped SVM to mainnet slot: ${currentMainnetSlot}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(`\n  Retry attempt ${attempt}/${maxRetries} (getting different route)...`);
    }

    // 1. Get Jupiter quote (direct routes only for fork reliability)
    console.log(`  Getting Jupiter quote: ${inputMint.slice(0, 8)}... → ${outputMint.slice(0, 8)}... (amount: ${amountIn})`);
    const quote = await getJupiterQuote({
      inputMint,
      outputMint,
      amount: amountIn,
      slippageBps: 1500, // 15% slippage for test reliability on forked chains
      onlyDirectRoutes: true,
    });
    const routeLabel = quote.routePlan.map((r) => r.swapInfo.label).join(" → ");
    console.log(`  Quote: ${quote.inAmount} → ${quote.outAmount} (route: ${routeLabel})`);

    // 2. Get swap transaction
    const swapResponse = await getJupiterSwapTransaction({
      quoteResponse: quote,
      userPublicKey: swapper.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 0,
    });

    // 3. Decode base64 → raw bytes
    const binary = atob(swapResponse.swapTransaction);
    const rawTx = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      rawTx[i] = binary.charCodeAt(i);
    }

    // 4. Parse V0 transaction
    const parsed = parseV0Transaction(rawTx);
    console.log(`  Parsed V0 tx: ${parsed.staticAccountKeys.length} static keys, ${parsed.addressTableLookups.length} ALTs, ${parsed.instructions.length} instructions`);

    // 5. Resolve ALTs — fetch ALT accounts from mainnet, parse them
    const altAddresses = extractAltAddresses(parsed);
    const resolvedAlts = new Map<string, Uint8Array[]>();
    let altFetchFailed = false;

    for (const altKeyBytes of altAddresses) {
      const altPubkey = new PublicKey(altKeyBytes);
      const altAccount = await fetchRpcAccount(rpcEndpoint, altPubkey);
      if (!altAccount) {
        console.log(`  ⚠ Failed to fetch ALT account: ${altPubkey.toBase58().slice(0, 12)}...`);
        altFetchFailed = true;
        break;
      }

      // Parse the ALT to extract stored addresses
      const addresses = parseAltAccount(altAccount.data);
      resolvedAlts.set(altPubkey.toBase58(), addresses);
      console.log(`  ALT ${altPubkey.toBase58().slice(0, 12)}...: ${addresses.length} addresses`);

      // Load the ALT account itself into SVM (LiteSVM needs it to process V0 txs)
      svm.setAccount(altKeyBytes, {
        lamports: altAccount.lamports,
        data: altAccount.data,
        owner: altAccount.owner,
        executable: altAccount.executable,
        rent_epoch: altAccount.rentEpoch,
      });
    }

    if (altFetchFailed) {
      if (attempt < maxRetries) {
        console.log(`  ⚠ Attempt ${attempt} failed (ALT fetch error), retrying...`);
        continue;
      }
      throw new Error("Failed to fetch ALT accounts after all retries");
    }

    // 6. Resolve ALL accounts the transaction touches
    const allAccountKeys = resolveAllAccounts(parsed, resolvedAlts);
    const uniqueKeys = new Map<string, Uint8Array>();
    for (const key of allAccountKeys) {
      uniqueKeys.set(encodeBase58(key), key);
    }
    console.log(`  Total unique accounts to load: ${uniqueKeys.size}`);

    // 7. Pre-load all accounts into SVM
    const pubkeys = [...uniqueKeys.values()].map((bytes) => new PublicKey(bytes));
    await client.ensureAccountKeysLoaded(pubkeys);

    // 8. Replace blockhash with local SVM's blockhash
    const localBlockhash = svm.latestBlockhash(); // Returns 32-byte Uint8Array
    let modifiedTx = replaceBlockhash(rawTx, parsed, localBlockhash);

    // 9. Re-sign with test keypair
    modifiedTx = await signRawV0Transaction(modifiedTx, parsed, swapper);

    // 10. Send raw bytes to SVM
    console.log(`  Sending swap transaction to local SVM...`);
    const result = svm.sendVersionedTransaction(modifiedTx);

    if (result.status === "ok" || attempt === maxRetries) {
      return { result, quote: { inAmount: quote.inAmount, outAmount: quote.outAmount } };
    }

    // Route failed — log and retry with a new quote (different route)
    console.log(`  ⚠ Attempt ${attempt} failed (route: ${routeLabel}): ${JSON.stringify(result.err)}`);
    if ("meta" in result) {
      const logs = result.meta.logs;
      const failLog = logs.find((l: string) => l.includes("failed:"));
      if (failLog) console.log(`    ${failLog}`);
    }
  }

  // Unreachable — last attempt always returns above
  throw new Error("unreachable");
}

// ============================================================================
// Tests
// ============================================================================

Deno.test(
  "jupiter swap: USDC → SOL on forked mainnet",
  { ignore: !Deno.env.get("SOLANA_RPC_URL")?.includes("mainnet") },
  async () => {
    const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;
    const client = new LocalClient({ rpcEndpoint });
    const svm = client.svm;
    const swapper = await Keypair.generate();

    // Fund with SOL for fees
    await client.requestAirdrop(swapper.publicKey, 5 * LAMPORTS_PER_SOL);

    // Hijack USDC balance: give swapper 100 USDC (6 decimals)
    const usdcMint = KNOWN_MINTS.USDC_MAINNET;
    const swapperUsdcAta = await getAssociatedTokenAddress(usdcMint, swapper.publicKey);
    svm.setTokenBalance({
      tokenAccount: swapperUsdcAta,
      mint: usdcMint,
      owner: swapper.publicKey,
      amount: BigInt(100_000_000), // 100 USDC
    });

    const initialSolBalance = await client.getBalance(swapper.publicKey);
    console.log(`\n  Initial SOL: ${initialSolBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Initial USDC: 100`);

    const { result, quote } = await executeJupiterSwap({
      rpcEndpoint,
      inputMint: usdcMint.toBase58(),
      outputMint: KNOWN_MINTS.WSOL.toBase58(),
      amountIn: "100000000", // 100 USDC
      swapper,
      client,
    });

    if (result.status === "err") {
      console.log("  Swap FAILED:", result.err);
      if ("meta" in result) {
        console.log("  Logs:", result.meta.logs.join("\n    "));
      }
    }
    assertEquals(result.status, "ok", "USDC → SOL swap should succeed");

    // Verify: USDC balance should be 0 (or near 0)
    const finalUsdcBalance = svm.getTokenBalance(swapperUsdcAta);
    assertEquals(finalUsdcBalance, BigInt(0), "All USDC should be swapped");

    // Verify: SOL balance should have increased
    const finalSolBalance = await client.getBalance(swapper.publicKey);
    assert(
      finalSolBalance > initialSolBalance - 100_000, // minus fees
      `Should have received SOL from swap (got ${finalSolBalance / LAMPORTS_PER_SOL} SOL)`,
    );

    console.log(`\n  ✅ USDC → SOL swap successful!`);
    console.log(`  Final SOL: ${finalSolBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Final USDC: ${Number(finalUsdcBalance) / 1e6}`);
    console.log(`  Expected output: ~${Number(quote.outAmount) / LAMPORTS_PER_SOL} SOL`);
  },
);

Deno.test(
  "jupiter swap: SOL → USDC on forked mainnet",
  { ignore: !Deno.env.get("SOLANA_RPC_URL")?.includes("mainnet") },
  async () => {
    const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;
    const client = new LocalClient({ rpcEndpoint });
    const svm = client.svm;
    const swapper = await Keypair.generate();

    // Fund with plenty of SOL (swap input + fees)
    await client.requestAirdrop(swapper.publicKey, 10 * LAMPORTS_PER_SOL);

    // Pre-create USDC ATA with 0 balance so we can verify the output
    const usdcMint = KNOWN_MINTS.USDC_MAINNET;
    const swapperUsdcAta = await getAssociatedTokenAddress(usdcMint, swapper.publicKey);
    svm.setTokenBalance({
      tokenAccount: swapperUsdcAta,
      mint: usdcMint,
      owner: swapper.publicKey,
      amount: BigInt(0),
    });

    const initialSolBalance = await client.getBalance(swapper.publicKey);
    console.log(`\n  Initial SOL: ${initialSolBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Initial USDC: 0`);

    const { result, quote } = await executeJupiterSwap({
      rpcEndpoint,
      inputMint: KNOWN_MINTS.WSOL.toBase58(),
      outputMint: usdcMint.toBase58(),
      amountIn: String(1 * LAMPORTS_PER_SOL), // 1 SOL
      swapper,
      client,
    });

    if (result.status === "err") {
      console.log("  Swap FAILED:", result.err);
      if ("meta" in result) {
        console.log("  Logs:", result.meta.logs.join("\n    "));
      }
    }
    assertEquals(result.status, "ok", "SOL → USDC swap should succeed");

    // Verify: USDC balance should be > 0
    const finalUsdcBalance = svm.getTokenBalance(swapperUsdcAta);
    assert(
      finalUsdcBalance > BigInt(0),
      `Should have received USDC from swap (got ${finalUsdcBalance})`,
    );

    // Verify: SOL balance decreased (spent ~1 SOL + fees)
    const finalSolBalance = await client.getBalance(swapper.publicKey);
    assert(
      finalSolBalance < initialSolBalance,
      "SOL balance should have decreased",
    );

    console.log(`\n  ✅ SOL → USDC swap successful!`);
    console.log(`  Final SOL: ${finalSolBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Final USDC: ${Number(finalUsdcBalance) / 1e6}`);
    console.log(`  Expected output: ~${Number(quote.outAmount) / 1e6} USDC`);
  },
);

Deno.test(
  "jupiter swap: USDT → USDC on forked mainnet",
  { ignore: !Deno.env.get("SOLANA_RPC_URL")?.includes("mainnet") },
  async () => {
    const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;
    const client = new LocalClient({ rpcEndpoint });
    const svm = client.svm;
    const swapper = await Keypair.generate();

    // Fund with SOL for fees
    await client.requestAirdrop(swapper.publicKey, 5 * LAMPORTS_PER_SOL);

    // Hijack USDT balance: give swapper 100 USDT (6 decimals)
    const usdtMint = KNOWN_MINTS.USDT_MAINNET;
    const usdcMint = KNOWN_MINTS.USDC_MAINNET;
    const swapperUsdtAta = await getAssociatedTokenAddress(usdtMint, swapper.publicKey);
    const swapperUsdcAta = await getAssociatedTokenAddress(usdcMint, swapper.publicKey);

    svm.setTokenBalance({
      tokenAccount: swapperUsdtAta,
      mint: usdtMint,
      owner: swapper.publicKey,
      amount: BigInt(100_000_000), // 100 USDT
    });
    svm.setTokenBalance({
      tokenAccount: swapperUsdcAta,
      mint: usdcMint,
      owner: swapper.publicKey,
      amount: BigInt(0),
    });

    console.log(`\n  Initial USDT: 100`);
    console.log(`  Initial USDC: 0`);

    const { result, quote } = await executeJupiterSwap({
      rpcEndpoint,
      inputMint: usdtMint.toBase58(),
      outputMint: usdcMint.toBase58(),
      amountIn: "100000000", // 100 USDT
      swapper,
      client,
    });

    if (result.status === "err") {
      console.log("  Swap FAILED:", result.err);
      if ("meta" in result) {
        console.log("  Logs:", result.meta.logs.join("\n    "));
      }
    }
    assertEquals(result.status, "ok", "USDT → USDC swap should succeed");

    // Verify: USDT balance should be 0
    const finalUsdtBalance = svm.getTokenBalance(swapperUsdtAta);
    assertEquals(finalUsdtBalance, BigInt(0), "All USDT should be swapped");

    // Verify: USDC balance should be > 0
    const finalUsdcBalance = svm.getTokenBalance(swapperUsdcAta);
    assert(
      finalUsdcBalance > BigInt(0),
      `Should have received USDC from swap (got ${finalUsdcBalance})`,
    );

    console.log(`\n  ✅ USDT → USDC swap successful!`);
    console.log(`  Final USDT: ${Number(finalUsdtBalance) / 1e6}`);
    console.log(`  Final USDC: ${Number(finalUsdcBalance) / 1e6}`);
    console.log(`  Expected output: ~${Number(quote.outAmount) / 1e6} USDC`);
  },
);
