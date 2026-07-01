import type {
    InnerInstruction as RawInnerInstruction,
    SerializableAccount,
} from "../litesvm.ts";
import type {
    Keypair,
    SolanaSigner,
    Transaction,
    VersionedTransaction,
} from "../solana.ts";
import { decodeBase58, encodeBase58, PublicKey } from "../solana.ts";

export type PubkeyInput = string | PublicKey;

export function toPubkey(input: PubkeyInput): PublicKey {
    return typeof input === "string" ? new PublicKey(input) : input;
}

export type Commitment = "processed" | "confirmed" | "finalized";

export interface Context {
    slot: number;
    apiVersion?: string;
}

export interface SignatureStatus {
    slot: number;
    confirmations: number | null;
    err: unknown | null;
    confirmationStatus: Commitment | null;
}

export interface SPLTokenBalance {
    accountIndex: number;
    mint: string;
    owner?: string;
    programId?: string;
    uiTokenAmount: SPLTokenAmount;
}

export interface InnerInstruction {
    index: number;
    instructions: {
        programIdIndex: number;
        accounts: number[];
        data: string;
        stackHeight?: number | null;
    }[];
}

/**
 * Drop the leading ShortU16 length prefix from a `#[serde(with =
 * "solana_short_vec")]` serialization. The first element is the encoded
 * length (a 1–3-byte nested array); the rest are the actual u8 payload.
 */
function stripShortVecHeader(arr: unknown[]): number[] {
    if (arr.length === 0) return [];
    return arr.slice(1) as number[];
}

/**
 * Convert the raw FFI-level `inner_instructions: Vec<Vec<InnerInstruction>>`
 * (indexed by outer-ix position, with empty sub-arrays for outer ixs that
 * didn't emit any CPIs) into the Solana-RPC-style shape the wider client
 * API uses: a sparse array where each entry carries the outer `index` it
 * belongs to plus the list of inner instructions in the expected public
 * format (camelCased, base58-encoded data).
 */
export function rawInnerInstructionsToApi(
    raw: RawInnerInstruction[][] | undefined | null,
): InnerInstruction[] | null {
    if (!raw || raw.length === 0) return null;
    const out: InnerInstruction[] = [];
    for (let i = 0; i < raw.length; i++) {
        const inners = raw[i];
        if (!inners || inners.length === 0) continue;
        out.push({
            index: i,
            instructions: inners.map((inner) => {
                const ci = inner.instruction;
                const accounts = stripShortVecHeader(ci.accounts);
                const data_bytes = stripShortVecHeader(ci.data);
                return {
                    programIdIndex: ci.programIdIndex,
                    accounts,
                    // Public API emits data as base58 to match real RPC behavior.
                    data: encodeBase58(new Uint8Array(data_bytes)),
                    stackHeight: inner.stackHeight,
                };
            }),
        });
    }
    return out.length === 0 ? null : out;
}

export interface ReturnData {
    programId: string;
    data: [string, string];
}

export interface LoadedAddresses {
    writable: string[];
    readonly: string[];
}

export interface AccountInfo {
    data: [string, string];
    executable: boolean;
    lamports: number;
    owner: string;
    rentEpoch: number;
    space: number;
}

export interface Reward {
    pubkey: string;
    lamports: number;
    postBalance: number;
    rewardType: string | null;
    commission: number | null;
}

export interface TransactionMeta {
    err: unknown | null;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    innerInstructions: InnerInstruction[] | null;
    logMessages: string[] | null;
    preTokenBalances: SPLTokenBalance[] | null;
    postTokenBalances: SPLTokenBalance[] | null;
    rewards: Reward[] | null;
    loadedAddresses?: LoadedAddresses;
    returnData?: ReturnData | null;
    computeUnitsConsumed?: number;
    numSignatures?: number;
}

export interface TransactionResponse {
    signature: string;
    slot: number;
    transaction: Transaction | VersionedTransaction | null;
    meta: TransactionMeta | null;
    blockTime: number | null;
    version?: "legacy" | number;
}

/** One instruction (outer or inner) lifted into a uniform shape: the
 *  `programIdIndex` resolved to its `PublicKey`, `data` as raw bytes (we
 *  base58-decode inner-ix data internally), and `account_indexes` ready
 *  to index into `staticAccountKeys`. */
export interface ParsedInstruction {
    program_id: PublicKey;
    data: Uint8Array;
    account_indexes: number[];
    /** True for inner (CPI) instructions, false for top-level ones in the
     *  tx message. Useful for callers that need to distinguish them
     *  (e.g. fee-accounting that only sums outer ixs). */
    inner: boolean;
}

/**
 * Walk every instruction in a transaction — top-level message
 * instructions first, then every CPI from `meta.innerInstructions` in
 * the order the runtime emitted them. Each yielded entry has its program
 * resolved against the tx's `staticAccountKeys` and its data decoded
 * from base58 (the wire form for inner ix data) so downstream parsers
 * (`SystemProgram.decodeInstruction`, etc.) don't need to know which
 * level the instruction came from.
 */
export function* iterateInstructions(
    tx: TransactionResponse,
): Generator<ParsedInstruction> {
    const sol_tx = tx.transaction;
    const keys = sol_tx?.staticAccountKeys ?? [];
    for (const ix of sol_tx?.instructions ?? []) {
        // Both `Transaction.instructions` and
        // `VersionedTransaction.instructions` return the resolved
        // `Instruction[]` shape now (programId + keys). Resolve the
        // per-key tx index by base58-comparing against `staticAccountKeys`.
        const program_id = ix.programId instanceof PublicKey
            ? ix.programId
            : new PublicKey(ix.programId);
        yield {
            program_id,
            data: ix.data,
            account_indexes: ix.keys.map((k) => {
                const pk = k.pubkey instanceof PublicKey
                    ? k.pubkey
                    : new PublicKey(k.pubkey);
                return keys.findIndex((kk) => kk.equals(pk));
            }),
            inner: false,
        };
    }
    for (const group of tx.meta?.innerInstructions ?? []) {
        for (const ix of group.instructions) {
            const program_id = keys[ix.programIdIndex];
            if (!program_id) continue;
            yield {
                program_id,
                data: decodeBase58(ix.data),
                account_indexes: ix.accounts,
                inner: true,
            };
        }
    }
}

export interface SimulateTransactionResult {
    context: Context;
    value: {
        err: unknown | null;
        logs: string[] | null;
        accounts: (AccountInfo | null)[] | null;
        unitsConsumed: number | null;
        returnData: ReturnData | null;
        innerInstructions: InnerInstruction[] | null;
        replacementBlockhash: {
            blockhash: string;
            lastValidBlockHeight: number;
        } | null;
        fee: number | null;
        preBalances: number[] | null;
        postBalances: number[] | null;
        preTokenBalances: SPLTokenBalance[] | null;
        postTokenBalances: SPLTokenBalance[] | null;
        loadedAddresses: LoadedAddresses | null;
    };
}

export interface SPLTokenAmount {
    amount: string;
    decimals: number;
    /** @deprecated Use uiAmountString instead */
    uiAmount: number | null;
    uiAmountString: string;
}

export interface SPLTokenAccountDelegate {
    delegate: string | null;
    delegatedAmount: bigint;
}

export interface KeyedAccount {
    pubkey: string;
    account: AccountInfo;
}

export interface BlockResponse {
    blockhash: string;
    previousBlockhash: string;
    parentSlot: number;
    blockHeight: number | null;
    blockTime: number | null;
    transactions?: {
        transaction: unknown;
        meta: TransactionMeta | null;
        version?: "legacy" | number;
    }[];
    rewards?: Reward[];
}

export interface EpochInfo {
    absoluteSlot: number;
    blockHeight: number;
    epoch: number;
    slotIndex: number;
    slotsInEpoch: number;
    transactionCount: number | null;
}

export interface VersionInfo {
    "solana-core": string;
    "feature-set": number;
}

export interface SignatureInfo {
    signature: string;
    slot: number;
    err: unknown | null;
    memo: string | null;
    blockTime: number | null;
    confirmationStatus: Commitment | null;
}

export interface SupplyValue {
    total: number;
    circulating: number;
    nonCirculating: number;
    nonCirculatingAccounts: string[];
}

export interface PrioritizationFee {
    slot: number;
    prioritizationFee: number;
}

export interface SimulationReturnData {
    programId: string;
    data: Uint8Array;
}

export interface SimulationAccount {
    pubkey: string;
    lamports: number;
    data: Uint8Array;
    owner: string;
    executable: boolean;
    rentEpoch: number;
}

export interface SimulationResult {
    err: unknown | null;
    logs: string[];
    accounts: (SimulationAccount | null)[] | null;
    loadedAccountsDataSize: number | null;
    returnData: SimulationReturnData | null;
    unitsConsumed: number;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: SPLTokenBalance[];
    postTokenBalances: SPLTokenBalance[];
    loadedAddresses: LoadedAddresses | null;
    /** Inner (CPI) instructions emitted during simulation, grouped by outer ix. */
    innerInstructions: InnerInstruction[] | null;
}

export interface DeployProgramResult {
    id: PublicKey;
    keypair: Keypair;
    programDataAddress?: PublicKey;
    signatures: string[];
}

export interface Client {
    latestBlockhash(): Promise<string>;
    requestAirdrop(pubkey: PubkeyInput, lamports: number): Promise<string>;
    getAccount(
        pubkey: PubkeyInput,
        opts?: { localOnly?: boolean },
    ): Promise<SerializableAccount | null>;
    loadAccounts(
        pubkeys: PubkeyInput[],
    ): Promise<Map<string, SerializableAccount | null>>;
    sendTransaction(
        tx: Transaction | VersionedTransaction,
        opts?: {
            skipPreflight?: boolean;
            commitment?: Commitment;
            confirmationTimeout?: number;
        },
    ): Promise<TransactionResponse>;
    simulateTransaction(
        tx: Transaction | VersionedTransaction,
        opts?: {
            commitment?: Commitment;
            sigVerify?: boolean;
            replaceRecentBlockhash?: boolean;
        },
    ): Promise<SimulationResult>;
    getNativeBalance(pubkey: PubkeyInput): Promise<number>;
    getSPLTokenAccountBalance(
        mint: PubkeyInput,
        owner: PubkeyInput,
    ): Promise<SPLTokenAmount>;
    getSPLTokenAccountDelegate(
        mint: PubkeyInput,
        owner: PubkeyInput,
    ): Promise<SPLTokenAccountDelegate>;
    getTransaction(signature: string): Promise<TransactionResponse | null>;
    getTransactions(
        signatures: string[],
    ): Promise<(TransactionResponse | null)[]>;
    getBlock(
        slot: number,
        opts?: { transactionDetails?: "full" | "signatures" | "none" },
    ): Promise<BlockResponse | null>;
    getSlot(commitment?: Commitment): Promise<number>;
    getSignaturesForAddress(
        address: PubkeyInput,
        opts?: {
            limit?: number;
            before?: string;
            until?: string;
            localOnly?: boolean;
        },
    ): Promise<SignatureInfo[]>;
    getRecentPrioritizationFees(
        addresses?: PubkeyInput[],
    ): Promise<PrioritizationFee[]>;
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    deployProgram(
        elfBytes: Uint8Array,
        opts?: {
            upgradeAuthority?: SolanaSigner;
            payer?: SolanaSigner;
            programKeypair?: Keypair;
            computeUnitPrice?: bigint;
            // Deploy upgradeable, then drop the upgrade authority so the
            // program is immutable. Requires `upgradeAuthority` to sign.
            immutable?: boolean;
        },
    ): Promise<DeployProgramResult>;
    createLookupTable(
        payer: SolanaSigner,
        addresses: PublicKey[],
    ): Promise<PublicKey>;
    deactivateLookupTable(
        authority: SolanaSigner,
        lookupTable: PublicKey,
    ): Promise<string>;
}
