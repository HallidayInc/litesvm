/**
 * Token swap tests using Jupiter V6 on a forked Solana mainnet chain.
 * Tests: USDC→SOL, SOL→USDC, USDT→USDC
 *
 * Requires a mainnet RPC endpoint:
 *   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com" deno test --allow-net --allow-env --allow-ffi --allow-read swap.test.ts
 */

import { assert, assertEquals } from "jsr:@std/assert";
import {
    decodeBase64,
    encodeBase58,
    getSPLAssociatedTokenAddress,
    Keypair,
    KNOWN_MINTS,
    LAMPORTS_PER_SOL,
    parseAltAccount,
    PublicKey,
    VersionedTransaction,
} from "../src/solana.ts";
import { TransactionResultEnvelope } from "../src/mod.ts";
import { LocalClient } from "../src/client.ts";
import { getJupiterQuote, getJupiterSwapTransaction } from "./jupiter.ts";

// ============================================================================
// Helpers
// ============================================================================

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
    const { inputMint, outputMint, amountIn, swapper, client } = opts;
    const maxRetries = opts.maxRetries ?? 3;
    const svm = client.svm;

    // Warp SVM to the current RPC slot so ALT `last_extended_slot` checks pass.
    await client.warpToCurrentRpcSlot();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (attempt > 1) {
            console.log(
                `\n  Retry attempt ${attempt}/${maxRetries} (getting different route)...`,
            );
        }

        // 1. Get Jupiter quote (direct routes only for fork reliability)
        console.log(
            `  Getting Jupiter quote: ${inputMint.slice(0, 8)}... → ${outputMint.slice(0, 8)}... (amount: ${amountIn})`,
        );
        const quote = await getJupiterQuote({
            inputMint,
            outputMint,
            amount: amountIn,
            slippageBps: 1500, // 15% slippage for test reliability on forked chains
            onlyDirectRoutes: true,
        });
        const routeLabel = quote.routePlan.map((r) => r.swapInfo.label).join(" → ");
        console.log(
            `  Quote: ${quote.inAmount} → ${quote.outAmount} (route: ${routeLabel})`,
        );

        // 2. Get swap transaction
        const swapResponse = await getJupiterSwapTransaction({
            quoteResponse: quote,
            userPublicKey: swapper.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 0,
        });

        // 3. Decode base64 → raw bytes and parse
        const tx = VersionedTransaction.fromBytes(
            decodeBase64(swapResponse.swapTransaction),
        );
        console.log(
            `  Parsed V0 tx: ${tx.staticAccountKeys.length} static keys, ${tx.addressTableLookups.length} ALTs, ${tx.instructions.length} instructions`,
        );

        // 4. Resolve ALTs — batch-fetch all ALT accounts from RPC and load into SVM
        const altAccountMap = await client.loadAccounts(
            tx.addressTableLookups.map((l) => l.accountKey),
        );
        const resolvedAlts = new Map<string, PublicKey[]>();
        let altFetchFailed = false;

        for (const [key, altAccount] of altAccountMap) {
            if (!altAccount) {
                console.log(`  ⚠ Failed to fetch ALT account: ${key.slice(0, 12)}...`);
                altFetchFailed = true;
                break;
            }
            const addresses = parseAltAccount(altAccount.data);
            resolvedAlts.set(key, addresses);
            console.log(
                `  ALT ${key.slice(0, 12)}...: ${addresses.length} addresses`,
            );
        }

        if (altFetchFailed) {
            if (attempt < maxRetries) {
                console.log(
                    `  ⚠ Attempt ${attempt} failed (ALT fetch error), retrying...`,
                );
                continue;
            }
            throw new Error("Failed to fetch ALT accounts after all retries");
        }

        // 5. Pre-load all accounts touched by the transaction
        const allAccounts = tx.resolveAllAccounts(resolvedAlts);
        console.log(`  Total unique accounts to load: ${allAccounts.length}`);
        await client.ensureAccountKeysLoaded(allAccounts);

        // 6. Replace blockhash, re-sign, and send
        tx.setBlockhash(encodeBase58(svm.latestBlockhash()));
        await tx.sign([swapper]);
        console.log(`  Sending swap transaction to local SVM...`);
        const result = svm.sendVersionedTransaction(tx.serialize());

        if (result.status === "ok" || attempt === maxRetries) {
            return {
                result,
                quote: { inAmount: quote.inAmount, outAmount: quote.outAmount },
            };
        }

        // Route failed — log and retry with a new quote (different route)
        console.log(
            `  ⚠ Attempt ${attempt} failed (route: ${routeLabel}): ${JSON.stringify(result.err)}`,
        );
        const failLog = result.logs.find((l: string) => l.includes("failed:"));
        if (failLog) console.log(`    ${failLog}`);
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
        const swapper = await Keypair.generate();

        // Fund with SOL for fees
        await client.requestAirdrop(swapper.publicKey, 5 * LAMPORTS_PER_SOL);

        // Hijack USDC balance: give swapper 100 USDC (6 decimals)
        const usdcMint = KNOWN_MINTS.USDC_MAINNET;
        const swapperUsdcAta = await getSPLAssociatedTokenAddress(
            usdcMint,
            swapper.publicKey,
        );
        client.setSPLTokenBalance(
            swapperUsdcAta,
            usdcMint,
            swapper.publicKey,
            BigInt(100_000_000),
        ); // 100 USDC

        const initialSolBalance = await client.getNativeBalance(swapper.publicKey);
        console.log(`\n  Initial SOL: ${initialSolBalance / LAMPORTS_PER_SOL} SOL`);
        console.log(`  Initial USDC: 100`);

        const { result, quote } = await executeJupiterSwap({
            inputMint: usdcMint.toBase58(),
            outputMint: KNOWN_MINTS.WSOL.toBase58(),
            amountIn: "100000000", // 100 USDC
            swapper,
            client,
        });

        if (result.status === "err") {
            console.log("  Swap FAILED:", result.err);
            console.log("  Logs:", result.logs.join("\n    "));
        }
        assertEquals(result.status, "ok", "USDC → SOL swap should succeed");

        // Verify: USDC balance should be 0 (or near 0)
        const finalUsdcBalance = client.getTokenAccountAmount(swapperUsdcAta);
        assertEquals(finalUsdcBalance, BigInt(0), "All USDC should be swapped");

        // Verify: SOL balance should have increased
        const finalSolBalance = await client.getNativeBalance(swapper.publicKey);
        assert(
            finalSolBalance > initialSolBalance - 100_000, // minus fees
            `Should have received SOL from swap (got ${finalSolBalance / LAMPORTS_PER_SOL} SOL)`,
        );

        console.log(`\n  ✅ USDC → SOL swap successful!`);
        console.log(`  Final SOL: ${finalSolBalance / LAMPORTS_PER_SOL} SOL`);
        console.log(`  Final USDC: ${Number(finalUsdcBalance) / 1e6}`);
        console.log(
            `  Expected output: ~${Number(quote.outAmount) / LAMPORTS_PER_SOL} SOL`,
        );
    },
);

Deno.test(
    "jupiter swap: SOL → USDC on forked mainnet",
    { ignore: !Deno.env.get("SOLANA_RPC_URL")?.includes("mainnet") },
    async () => {
        const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;
        const client = new LocalClient({ rpcEndpoint });
        const swapper = await Keypair.generate();

        // Fund with plenty of SOL (swap input + fees)
        await client.requestAirdrop(swapper.publicKey, 10 * LAMPORTS_PER_SOL);

        // Pre-create USDC ATA with 0 balance so we can verify the output
        const usdcMint = KNOWN_MINTS.USDC_MAINNET;
        const swapperUsdcAta = await getSPLAssociatedTokenAddress(
            usdcMint,
            swapper.publicKey,
        );
        client.setSPLTokenBalance(
            swapperUsdcAta,
            usdcMint,
            swapper.publicKey,
            BigInt(0),
        );

        const initialSolBalance = await client.getNativeBalance(swapper.publicKey);
        console.log(`\n  Initial SOL: ${initialSolBalance / LAMPORTS_PER_SOL} SOL`);
        console.log(`  Initial USDC: 0`);

        const { result, quote } = await executeJupiterSwap({
            inputMint: KNOWN_MINTS.WSOL.toBase58(),
            outputMint: usdcMint.toBase58(),
            amountIn: String(1 * LAMPORTS_PER_SOL), // 1 SOL
            swapper,
            client,
        });

        if (result.status === "err") {
            console.log("  Swap FAILED:", result.err);
            console.log("  Logs:", result.logs.join("\n    "));
        }
        assertEquals(result.status, "ok", "SOL → USDC swap should succeed");

        // Verify: USDC balance should be > 0
        const finalUsdcBalance = client.getTokenAccountAmount(swapperUsdcAta);
        assert(
            finalUsdcBalance > BigInt(0),
            `Should have received USDC from swap (got ${finalUsdcBalance})`,
        );

        // Verify: SOL balance decreased (spent ~1 SOL + fees)
        const finalSolBalance = await client.getNativeBalance(swapper.publicKey);
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
        const swapper = await Keypair.generate();

        // Fund with SOL for fees
        await client.requestAirdrop(swapper.publicKey, 5 * LAMPORTS_PER_SOL);

        // Hijack USDT balance: give swapper 100 USDT (6 decimals)
        const usdtMint = KNOWN_MINTS.USDT_MAINNET;
        const usdcMint = KNOWN_MINTS.USDC_MAINNET;
        const swapperUsdtAta = await getSPLAssociatedTokenAddress(
            usdtMint,
            swapper.publicKey,
        );
        const swapperUsdcAta = await getSPLAssociatedTokenAddress(
            usdcMint,
            swapper.publicKey,
        );

        client.setSPLTokenBalance(
            swapperUsdtAta,
            usdtMint,
            swapper.publicKey,
            BigInt(100_000_000),
        ); // 100 USDT
        client.setSPLTokenBalance(
            swapperUsdcAta,
            usdcMint,
            swapper.publicKey,
            BigInt(0),
        );

        console.log(`\n  Initial USDT: 100`);
        console.log(`  Initial USDC: 0`);

        const { result, quote } = await executeJupiterSwap({
            inputMint: usdtMint.toBase58(),
            outputMint: usdcMint.toBase58(),
            amountIn: "100000000", // 100 USDT
            swapper,
            client,
        });

        if (result.status === "err") {
            console.log("  Swap FAILED:", result.err);
            console.log("  Logs:", result.logs.join("\n    "));
        }
        assertEquals(result.status, "ok", "USDT → USDC swap should succeed");

        // Verify: USDT balance should be 0
        const finalUsdtBalance = client.getTokenAccountAmount(swapperUsdtAta);
        assertEquals(finalUsdtBalance, BigInt(0), "All USDT should be swapped");

        // Verify: USDC balance should be > 0
        const finalUsdcBalance = client.getTokenAccountAmount(swapperUsdcAta);
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
