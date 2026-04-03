/**
 * Minimal Jupiter V6 API client for Solana token swaps.
 * Uses only fetch() — no external dependencies.
 */

/** Jupiter free-tier API (lite-api.jup.ag). No API key required. */
const JUPITER_API_BASE = "https://lite-api.jup.ag/swap/v1";

// ============================================================================
// Types
// ============================================================================

export interface JupiterQuoteParams {
    /** Input token mint address (base58) */
    inputMint: string;
    /** Output token mint address (base58) */
    outputMint: string;
    /** Amount of input tokens (in smallest denomination, as string) */
    amount: string;
    /** Slippage tolerance in basis points (default: 300 = 3%) */
    slippageBps?: number;
    /** Swap mode (default: "ExactIn") */
    swapMode?: "ExactIn" | "ExactOut";
    /** Only return direct routes (no intermediate hops). Useful for forked testing. */
    onlyDirectRoutes?: boolean;
    /** Maximum number of accounts the transaction can use. Lower values force simpler routes. */
    maxAccounts?: number;
    /** Comma-separated list of DEX labels to exclude from routing. */
    excludeDexes?: string;
}

export interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
        percent: number;
    }>;
    contextSlot?: number;
    timeTaken?: number;
}

export interface JupiterSwapParams {
    /** The quote response from getJupiterQuote */
    quoteResponse: JupiterQuoteResponse;
    /** The user's public key (base58) — will be the fee payer and signer */
    userPublicKey: string;
    /** Whether to auto wrap/unwrap SOL (default: true) */
    wrapAndUnwrapSol?: boolean;
    /** Whether to dynamically compute the compute unit limit (default: true) */
    dynamicComputeUnitLimit?: boolean;
    /** Prioritization fee in lamports, or "auto" (default: 0) */
    prioritizationFeeLamports?: number | "auto";
}

export interface JupiterSwapResponse {
    /** Base64-encoded serialized VersionedTransaction */
    swapTransaction: string;
    lastValidBlockHeight: number;
    prioritizationFeeLamports: number;
    computeUnitLimit: number;
    prioritizationType?: {
        computeBudget: {
            microLamports: number;
            estimatedMicroLamports: number;
        };
    };
    dynamicSlippageReport?: unknown;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get a swap quote from Jupiter V6.
 *
 * @example
 * const quote = await getJupiterQuote({
 *   inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
 *   outputMint: "So11111111111111111111111111111111111111112",    // WSOL
 *   amount: "100000000", // 100 USDC (6 decimals)
 *   slippageBps: 300,    // 3%
 * });
 */
export async function getJupiterQuote(
    params: JupiterQuoteParams,
): Promise<JupiterQuoteResponse> {
    const url = new URL(`${JUPITER_API_BASE}/quote`);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    url.searchParams.set("slippageBps", String(params.slippageBps ?? 300));
    if (params.swapMode) {
        url.searchParams.set("swapMode", params.swapMode);
    }
    if (params.onlyDirectRoutes) {
        url.searchParams.set("onlyDirectRoutes", "true");
    }
    if (params.maxAccounts !== undefined) {
        url.searchParams.set("maxAccounts", String(params.maxAccounts));
    }
    if (params.excludeDexes) {
        url.searchParams.set("excludeDexes", params.excludeDexes);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
    }
    return res.json();
}

/**
 * Get a serialized swap transaction from Jupiter V6.
 * Returns a base64-encoded VersionedTransaction that can be decoded,
 * modified (blockhash replacement), re-signed, and executed.
 *
 * @example
 * const swap = await getJupiterSwapTransaction({
 *   quoteResponse: quote,
 *   userPublicKey: wallet.publicKey.toBase58(),
 * });
 * // swap.swapTransaction is base64-encoded V0 transaction bytes
 */
export async function getJupiterSwapTransaction(
    params: JupiterSwapParams,
): Promise<JupiterSwapResponse> {
    const res = await fetch(`${JUPITER_API_BASE}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            quoteResponse: params.quoteResponse,
            userPublicKey: params.userPublicKey,
            wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
            dynamicComputeUnitLimit: params.dynamicComputeUnitLimit ?? true,
            prioritizationFeeLamports: params.prioritizationFeeLamports ?? 0,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Jupiter swap failed (${res.status}): ${body}`);
    }
    return res.json();
}
