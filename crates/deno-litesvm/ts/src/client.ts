import {
    InnerInstruction as RawInnerInstruction,
    LiteSvm,
    SerializableAccount,
    SimulationResultEnvelope,
    TransactionResultEnvelope,
    TransactionResultErr,
    TransactionResultOk,
} from "./mod.ts";
import {
    ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    AddressLookupTableProgram,
    BPF_LOADER_UPGRADEABLE_ID,
    BPF_LOADER_V1_ID,
    BPF_LOADER_V2_ID,
    BpfLoader,
    BpfLoaderUpgradeable,
    buildAltAccountData,
    BUILTIN_PROGRAMS,
    chunkedWrite,
    ComputeBudgetProgram,
    decodeBase58,
    deserializeTransaction,
    encodeBase58,
    findProgramAddress,
    getSPLAssociatedTokenAddress,
    InstructionInput,
    Keypair,
    LOADER_V4_ID,
    MessageV0,
    parseAltAccount,
    PublicKey,
    SolanaSigner,
    SystemProgram,
    Transaction,
    VersionedTransaction,
} from "./solana.ts";
import {
    parseTokenAccountData,
    TOKEN_2022_PROGRAM_PUBKEY,
    TOKEN_ACCOUNT_RENT_EXEMPTION,
    TOKEN_ACCOUNT_SIZE,
    TOKEN_PROGRAM_PUBKEY,
    WSOL_MINT_ADDRESS,
} from "./solana.ts";

export type PubkeyInput = string | PublicKey;

function toPubkey(input: PubkeyInput): PublicKey {
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
function rawInnerInstructionsToApi(
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
        const program_id = ix.programId instanceof PublicKey ? ix.programId : new PublicKey(ix.programId);
        yield {
            program_id,
            data: ix.data,
            account_indexes: ix.keys.map((k) => {
                const pk = k.pubkey instanceof PublicKey ? k.pubkey : new PublicKey(k.pubkey);
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
    getAccount(pubkey: PubkeyInput): Promise<SerializableAccount | null>;
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
        opts?: { limit?: number; before?: string; until?: string },
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
}

const PROGRAM_DATA_HEADER_SIZE = 45;
const BUFFER_HEADER_SIZE = 37;

function base64ToBytes(data: string): Uint8Array {
    const binary = atob(data);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        buf[i] = binary.charCodeAt(i);
    }
    return buf;
}

function normalizeAccount(value: unknown): SerializableAccount | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    if (value instanceof Uint8Array) {
        return null;
    }

    const candidate = value as Record<string, unknown>;

    const lamports = candidate.lamports;
    const executable = candidate.executable;
    const rawRentEpoch = (candidate.rent_epoch ?? candidate.rentEpoch) as
        | number
        | undefined;
    const owner = candidate.owner;
    const data = candidate.data;

    // Cap rent_epoch to a safe value - mainnet can return max u64 which causes
    // deserialization issues. For testing purposes, we just need a valid value.
    // Max safe integer in JS is 2^53 - 1, but we'll use 0 for simplicity since
    // rent_epoch isn't critical for transaction execution.
    const rentEpoch = rawRentEpoch !== undefined && rawRentEpoch > Number.MAX_SAFE_INTEGER ? 0 : (rawRentEpoch ?? 0);

    if (
        typeof lamports === "number" &&
        typeof executable === "boolean" &&
        typeof rentEpoch === "number"
    ) {
        if (owner instanceof Uint8Array && data instanceof Uint8Array) {
            const account: SerializableAccount = {
                lamports,
                data,
                owner,
                executable,
                rent_epoch: rentEpoch,
            };
            return account;
        }

        if (typeof owner === "string" && Array.isArray(data)) {
            const [payload, encoding] = data as [string, string];
            const bytes = encoding === "base64" ? base64ToBytes(payload) : new Uint8Array();
            const account: SerializableAccount = {
                lamports,
                data: bytes,
                owner: new PublicKey(owner).toBytes(),
                executable,
                rent_epoch: rentEpoch,
            };
            return account;
        }
    }

    return null;
}

function isVersioned(
    tx: Transaction | VersionedTransaction,
): tx is VersionedTransaction {
    return "version" in tx;
}

// Solana's hard transaction wire-size cap (PACKET_DATA_SIZE). A real RPC rejects
// anything larger before it ever reaches the runtime, but litesvm bypasses the
// banking/packet stage and will happily process an oversized tx — which silently
// masks chunking bugs (program-deploy writes, solution-account chunks) that only
// surface against a real cluster. Enforce it here so litesvm-backed simulations
// fail the same way a real RPC would.
export const MAX_TX_WIRE_SIZE = 1232;

function enforceTxWireSize(bytes: Uint8Array): void {
    if (bytes.length > MAX_TX_WIRE_SIZE) {
        throw new Error(
            `Transaction too large: ${bytes.length} bytes (max raw ${MAX_TX_WIRE_SIZE}, ` +
                `base64 ${Math.ceil(bytes.length / 3) * 4}). A real RPC would reject this; ` +
                `litesvm enforces the same limit. Split the work into smaller transactions.`,
        );
    }
}

// Maps a token-2022 mint's extensions to the account-side extensions its token
// accounts must carry. ATAs always include ImmutableOwner; TransferFeeConfig,
// NonTransferable, and TransferHook mints mandate matching account extensions.
function requiredAccountExtensions(
    mint_data?: Uint8Array,
): { type: number; data: Uint8Array }[] {
    const exts: { type: number; data: Uint8Array }[] = [
        { type: 7, data: new Uint8Array(0) }, // ImmutableOwner
    ];
    if (!mint_data || mint_data.length <= TOKEN_ACCOUNT_SIZE) return exts;
    // Mint extensions are TLV-encoded after the AccountType byte at offset 165.
    const dv = new DataView(
        mint_data.buffer,
        mint_data.byteOffset,
        mint_data.byteLength,
    );
    let off = TOKEN_ACCOUNT_SIZE + 1;
    while (off + 4 <= mint_data.length) {
        const type = dv.getUint16(off, true);
        const len = dv.getUint16(off + 2, true);
        if (type === 0 && len === 0) break; // Uninitialized terminator
        if (type === 1) exts.push({ type: 2, data: new Uint8Array(8) }); // TransferFeeConfig -> TransferFeeAmount
        if (type === 9) exts.push({ type: 13, data: new Uint8Array(0) }); // NonTransferable -> NonTransferableAccount
        if (type === 14) exts.push({ type: 15, data: new Uint8Array(1) }); // TransferHook -> TransferHookAccount
        off += 4 + len;
    }
    return exts;
}

export class LocalClient implements Client {
    #svm: LiteSvm;
    #rpc: RpcClient;
    #autoFetch: boolean;
    #loadedAccounts: Set<string> = new Set();
    #sigCounts: Map<string, number> = new Map();
    /**
     * Per-tx metadata captured at `sendTransaction` time so
     * `getTransaction` can reconstruct a Solana-RPC-like
     * `TransactionResponse.meta`. LiteSVM itself doesn't track
     * pre/post balances or token balances, so we snapshot them
     * around the SVM call and stash them here.
     */
    #txStore: Map<string, {
        bytes: Uint8Array;
        slot: number;
        preBalances: number[];
        postBalances: number[];
        preTokenBalances: SPLTokenBalance[];
        postTokenBalances: SPLTokenBalance[];
    }> = new Map();

    constructor(opts: {
        svm?: LiteSvm;
        rpcEndpoint: string;
        autoFetchAccounts?: boolean;
    }) {
        this.#svm = opts.svm ?? new LiteSvm();
        this.#rpc = new RpcClient(opts.rpcEndpoint);
        this.#autoFetch = opts.autoFetchAccounts ?? true;
        this.#svm.setClockInfo({
            ...this.#svm.getClockInfo(),
            unix_timestamp: Math.floor(Date.now() / 1000),
        });
    }

    get svm(): LiteSvm {
        return this.#svm;
    }

    get rpcClient(): RpcClient {
        return this.#rpc;
    }

    async latestBlockhash(): Promise<string> {
        return this.#svm.latestBlockhashString();
    }

    async requestAirdrop(pubkey: PubkeyInput, lamports: number): Promise<string> {
        const pk = toPubkey(pubkey);
        this.#svm.expireBlockhash();
        this.#svm.airdrop(pk.toBytes(), lamports);
        const rand = crypto.getRandomValues(new Uint8Array(64));
        return encodeBase58(rand);
    }

    async getAccount(pubkey: PubkeyInput): Promise<SerializableAccount | null> {
        const pk = toPubkey(pubkey);

        const localAccount = this.#svm.getAccount(pk.toBytes());
        if (localAccount) return localAccount;

        if (this.#autoFetch) {
            const remoteAccount = await this.#rpc.getAccount(pk);
            if (remoteAccount) {
                this.#svm.setAccount(pk.toBytes(), remoteAccount);
                this.#loadedAccounts.add(pk.toBase58());
            }
            return remoteAccount;
        }

        return null;
    }

    async loadAccounts(
        pubkeys: PubkeyInput[],
    ): Promise<Map<string, SerializableAccount | null>> {
        const pks = pubkeys.map(toPubkey);
        const results = await this.#rpc.getMultipleAccounts(pks);
        for (const [key, account] of results) {
            if (account) {
                this.#svm.setAccount(new PublicKey(key).toBytes(), account);
                this.#loadedAccounts.add(key);
            }
        }
        return results;
    }

    async getNativeBalance(pubkey: PubkeyInput): Promise<number> {
        const account = await this.getAccount(pubkey);
        return account?.lamports ?? 0;
    }

    async getSPLTokenAccountBalance(
        mint: PubkeyInput,
        owner: PubkeyInput,
    ): Promise<SPLTokenAmount> {
        // Detect Token-2022 from the mint's owner program so the ATA
        // derivation matches where Token-2022 mints (PYUSD etc) actually
        // live. Without this, the default-TokenkegQ ATA lookup returns
        // empty for any Token-2022 holder.
        const mint_pk = toPubkey(mint);
        const mint_acc = this.svm.getAccount(mint_pk.toBytes());
        const token_program = mint_acc &&
                new PublicKey(mint_acc.owner).toBase58() === TOKEN_2022_PROGRAM_PUBKEY
            ? new PublicKey(TOKEN_2022_PROGRAM_PUBKEY)
            : undefined;
        const ata = await getSPLAssociatedTokenAddress(
            mint_pk,
            toPubkey(owner),
            token_program,
        );
        const account = this.svm.getAccount(ata.toBytes());
        if (!account || account.data.length < TOKEN_ACCOUNT_SIZE) {
            return { amount: "0", decimals: 0, uiAmount: 0, uiAmountString: "0" };
        }
        const balance = new DataView(
            account.data.buffer,
            account.data.byteOffset,
            account.data.byteLength,
        ).getBigUint64(64, true);
        const amountStr = balance.toString();
        return {
            amount: amountStr,
            decimals: 0,
            uiAmount: Number(balance),
            uiAmountString: amountStr,
        };
    }

    async getSPLTokenAccountDelegate(
        mint: PubkeyInput,
        owner: PubkeyInput,
    ): Promise<SPLTokenAccountDelegate> {
        const ata = await getSPLAssociatedTokenAddress(
            toPubkey(mint),
            toPubkey(owner),
        );
        const account = this.svm.getAccount(ata.toBytes());
        if (!account || account.data.length < TOKEN_ACCOUNT_SIZE) {
            return { delegate: null, delegatedAmount: 0n };
        }
        const view = new DataView(
            account.data.buffer,
            account.data.byteOffset,
            account.data.byteLength,
        );
        const hasDelegate = view.getUint32(72, true) === 1;
        if (!hasDelegate) {
            return { delegate: null, delegatedAmount: 0n };
        }
        const delegatePubkey = new PublicKey(account.data.slice(76, 108));
        const delegatedAmount = view.getBigUint64(121, true);
        return { delegate: delegatePubkey.toBase58(), delegatedAmount };
    }

    async getTransaction(signature: string): Promise<TransactionResponse | null> {
        let sigBytes: Uint8Array;
        try {
            sigBytes = decodeBase58(signature);
        } catch {
            return null;
        }
        if (sigBytes.length !== 64) return null;

        const result = this.#svm.getTransactionBySignature(sigBytes);

        if (result) {
            const clock = this.#svm.getClockInfo();
            const isOk = result.status === "ok";

            const stored = this.#txStore.get(signature);
            const transaction = stored ? deserializeTransaction(stored.bytes) : null;
            const version = transaction instanceof VersionedTransaction ? 0 : ("legacy" as const);

            // pre/post balance arrays + token balances come from the
            // snapshot we took in `sendTransaction`. They're absent
            // only for txs replayed before this client was rev'd; we
            // fall back to empty/null in that case (same as before).
            return {
                signature,
                slot: stored?.slot ?? clock.slot,
                transaction,
                meta: {
                    err: isOk ? null : (result as TransactionResultErr).err,
                    fee: result.fee,
                    preBalances: stored?.preBalances ?? [],
                    postBalances: stored?.postBalances ?? [],
                    innerInstructions: rawInnerInstructionsToApi(
                        result.inner_instructions,
                    ),
                    logMessages: result.logs,
                    preTokenBalances: stored?.preTokenBalances ?? null,
                    postTokenBalances: stored?.postTokenBalances ?? null,
                    rewards: null,
                    computeUnitsConsumed: result.compute_units_consumed,
                    numSignatures: this.#sigCounts.get(signature),
                    returnData: null,
                },
                blockTime: Math.floor(clock.unix_timestamp),
                version,
            };
        }

        return this.#rpc.getTransaction(signature);
    }

    async getTransactions(
        signatures: string[],
    ): Promise<(TransactionResponse | null)[]> {
        return Promise.all(signatures.map((sig) => this.getTransaction(sig)));
    }

    async getRecentPrioritizationFees(
        addresses?: PubkeyInput[],
    ): Promise<PrioritizationFee[]> {
        return this.#rpc.getRecentPrioritizationFees(addresses);
    }

    async #ensureAccountsLoaded(
        tx: Transaction | VersionedTransaction,
    ): Promise<void> {
        if (!this.#autoFetch) return;

        const accountKeys: PublicKey[] = [...tx.staticAccountKeys];

        if (isVersioned(tx) && tx.addressTableLookups.length > 0) {
            // Fetch every ALT account first, parse, and append the indices the
            // tx actually references. Cache ALT accounts in `#loadedAccounts`
            // so repeated sends don't re-fetch them.
            // Prefer ALTs already present in the SVM (e.g. injected for tests);
            // only hit RPC for ALTs that exist solely on the remote cluster.
            const altKeys = tx.addressTableLookups.map((l) => l.accountKey);
            const remoteAltKeys = altKeys.filter(
                (k) => !this.#svm.getAccount(k.toBytes()),
            );
            const remoteAltMap = remoteAltKeys.length > 0
                ? await this.#rpc.getMultipleAccounts(remoteAltKeys)
                : new Map<string, SerializableAccount | null>();
            for (const lookup of tx.addressTableLookups) {
                const altKeyStr = lookup.accountKey.toBase58();
                const local = this.#svm.getAccount(lookup.accountKey.toBytes());
                let altData: Uint8Array;
                if (local) {
                    altData = local.data;
                    this.#loadedAccounts.add(altKeyStr);
                } else {
                    const altAccount = remoteAltMap.get(altKeyStr);
                    if (!altAccount) {
                        throw new Error(
                            `ensureAccountsLoaded: ALT account not found: ${altKeyStr}`,
                        );
                    }
                    // Persist the ALT itself; the runtime needs to read it during exec.
                    if (!this.#loadedAccounts.has(altKeyStr)) {
                        this.#svm.setAccount(lookup.accountKey.toBytes(), altAccount);
                        this.#loadedAccounts.add(altKeyStr);
                    }
                    altData = altAccount.data;
                }
                const altAddresses = parseAltAccount(altData);
                for (const idx of lookup.writableIndexes) {
                    if (idx < altAddresses.length) accountKeys.push(altAddresses[idx]);
                }
                for (const idx of lookup.readonlyIndexes) {
                    if (idx < altAddresses.length) accountKeys.push(altAddresses[idx]);
                }
            }
        }

        const accountsToFetch: PublicKey[] = [];
        for (const pk of accountKeys) {
            const pkStr = pk.toBase58();
            if (!this.#loadedAccounts.has(pkStr) && !BUILTIN_PROGRAMS.has(pkStr)) {
                const existing = this.#svm.getAccount(pk.toBytes());
                if (!existing) {
                    accountsToFetch.push(pk);
                } else {
                    this.#loadedAccounts.add(pkStr);
                }
            }
        }

        if (accountsToFetch.length === 0) return;

        const accountMap = await this.#rpc.getMultipleAccounts(accountsToFetch);

        const programsToLoad: PublicKey[] = [];

        for (const [pkStr, account] of accountMap) {
            if (account) {
                const pk = new PublicKey(pkStr);

                if (account.executable) {
                    programsToLoad.push(pk);
                } else {
                    this.#svm.setAccount(pk.toBytes(), account);
                    this.#loadedAccounts.add(pkStr);
                }
            }
        }

        for (const programId of programsToLoad) {
            await this.#loadProgram(programId);
        }
    }

    /**
     * Explicitly load programs from the RPC into LiteSVM. Handles every loader
     * variant that deploys executable BPF programs — BPFLoader1, BPFLoader2,
     * BPFLoaderUpgradeable, and LoaderV4 — and throws on failure instead of
     * silently skipping, so callers can rely on the program being invokable
     * after this call returns. Prefer this over ensureAccountKeysLoaded when
     * you need CPI targets available in simulation.
     */
    async ensureProgramsLoaded(programIds: PubkeyInput[]): Promise<void> {
        for (const id of programIds) {
            const pk = toPubkey(id);
            await this.#loadProgram(pk);
        }
    }

    async #loadProgram(programId: PublicKey): Promise<void> {
        const pkStr = programId.toBase58();
        if (this.#loadedAccounts.has(pkStr)) return;

        const { programAccount, programDataAccount, programDataAddress } = await this.#rpc.getProgramData(programId);

        if (!programAccount) {
            throw new Error(
                `ensureProgramsLoaded: program account not found for ${pkStr}`,
            );
        }
        if (!programAccount.executable) {
            // Not a program — caller gave us a regular account; just persist it.
            this.#svm.setAccount(programId.toBytes(), programAccount);
            this.#loadedAccounts.add(pkStr);
            return;
        }

        const ownerStr = new PublicKey(programAccount.owner).toBase58();
        const V4_HEADER_SIZE = 48;

        if (ownerStr === BPF_LOADER_UPGRADEABLE_ID.toBase58()) {
            if (!programDataAccount || !programDataAddress) {
                throw new Error(
                    `ensureProgramsLoaded: upgradeable program ${pkStr} has no program data account`,
                );
            }
            if (programDataAccount.data.length <= PROGRAM_DATA_HEADER_SIZE) {
                throw new Error(
                    `ensureProgramsLoaded: upgradeable program ${pkStr} has empty program data`,
                );
            }

            const elfBytes = programDataAccount.data.slice(PROGRAM_DATA_HEADER_SIZE);
            this.#svm.addProgram(programId.toBytes(), elfBytes);
            this.#svm.setAccount(programDataAddress.toBytes(), programDataAccount);
            this.#loadedAccounts.add(programDataAddress.toBase58());
        } else if (
            ownerStr === BPF_LOADER_V2_ID.toBase58() ||
            ownerStr === BPF_LOADER_V1_ID.toBase58()
        ) {
            this.#svm.addProgram(programId.toBytes(), programAccount.data);
        } else if (ownerStr === LOADER_V4_ID.toBase58()) {
            if (programAccount.data.length <= V4_HEADER_SIZE) {
                throw new Error(
                    `ensureProgramsLoaded: v4 program ${pkStr} data smaller than header`,
                );
            }
            const elfBytes = programAccount.data.slice(V4_HEADER_SIZE);
            this.#svm.addProgram(programId.toBytes(), elfBytes);
        } else {
            throw new Error(
                `ensureProgramsLoaded: program ${pkStr} has unsupported loader owner ${ownerStr}`,
            );
        }
        this.#loadedAccounts.add(pkStr);
    }

    /**
     * Toggle the "auto-fetch missing accounts from RPC" behavior at
     * runtime. The constructor sets this once based on the
     * `autoFetchAccounts` option, but tests that pre-populate the SVM
     * with synthetic state (mints, ATAs, etc.) often want to disable
     * the fetch entirely after setup so a stray account lookup
     * doesn't hit a placeholder RPC URL and break things.
     */
    setAutoFetch(enabled: boolean): void {
        this.#autoFetch = enabled;
    }

    /**
     * Snapshot every account in a tx's `staticAccountKeys` into the
     * pair of arrays Solana RPC's `getTransaction` returns for
     * pre-/post-state diffing:
     *
     *   - `balances[i]` = lamports of `staticAccountKeys[i]` (0 if the
     *     account doesn't exist yet — e.g. a fresh ATA the tx is
     *     about to create).
     *   - `tokenBalances` is the (sparse) subset of those accounts
     *     whose owner is the SPL token program. Each entry has the
     *     parsed mint / owner / amount + the mint's decimals so the
     *     `uiTokenAmount` shape matches what real RPC nodes return.
     *
     * LiteSVM doesn't track these natively, so we call this around
     * the SVM's send and stash both snapshots in `#txStore` for
     * `getTransaction` to read back. Same data is also returned
     * straight from `sendTransaction` itself.
     */
    #snapshotTxBalances(
        tx: Transaction | VersionedTransaction,
    ): { balances: number[]; tokenBalances: SPLTokenBalance[] } {
        const keys = tx.staticAccountKeys;
        const balances: number[] = [];
        const tokenBalances: SPLTokenBalance[] = [];
        for (let i = 0; i < keys.length; i++) {
            const key_bytes = keys[i].toBytes();
            const account = this.#svm.getAccount(key_bytes);
            if (!account) {
                // Solana RPC returns `0` for accounts that don't yet
                // exist at the snapshot point — match that so the
                // pre/post diff a tx that creates the account
                // produces a sensible positive delta.
                balances.push(0);
                continue;
            }
            balances.push(Number(account.lamports));

            // SPL token account: owner === Token Program AND data is
            // ≥165 bytes (smaller buffers can't be valid token
            // accounts; ignore anything that doesn't parse cleanly).
            const owner_pk = new PublicKey(account.owner);
            if (
                owner_pk.toBase58() !== TOKEN_PROGRAM_PUBKEY ||
                account.data.length < TOKEN_ACCOUNT_SIZE
            ) continue;

            let parsed;
            try {
                parsed = parseTokenAccountData(account.data);
            } catch {
                continue;
            }
            // Pull `decimals` from the mint account if we have it
            // locally — RPC's `uiTokenAmount` reports decimals, and a
            // mismatch versus what `getTransfers` (or any other
            // consumer) computes from `amount` is annoying to debug.
            // Default to 0 if the mint isn't loaded; only the
            // `amount` field is functionally required.
            let decimals = 0;
            const mint_account = this.#svm.getAccount(parsed.mint);
            if (mint_account && mint_account.data.length >= 45) {
                decimals = mint_account.data[44];
            }

            const amount_n = parsed.amount;
            const ui_amount = decimals > 0 ? Number(amount_n) / Math.pow(10, decimals) : Number(amount_n);
            tokenBalances.push({
                accountIndex: i,
                mint: new PublicKey(parsed.mint).toBase58(),
                owner: new PublicKey(parsed.owner).toBase58(),
                programId: TOKEN_PROGRAM_PUBKEY,
                uiTokenAmount: {
                    amount: amount_n.toString(),
                    decimals,
                    uiAmount: ui_amount,
                    uiAmountString: ui_amount.toString(),
                },
            });
        }
        return { balances, tokenBalances };
    }

    async sendTransaction(
        tx: Transaction | VersionedTransaction,
        _options?: {
            skipPreflight?: boolean;
            commitment?: Commitment;
            confirmationTimeout?: number;
        },
    ): Promise<TransactionResponse> {
        await this.#ensureAccountsLoaded(tx);

        const bytes = tx.serialize();
        enforceTxWireSize(bytes);
        const num_signatures = bytes[0];

        // Snapshot pre-state, send, snapshot post-state. The two
        // calls flank the SVM dispatch so the deltas correspond
        // exactly to what this single tx changed. If the tx errors
        // mid-execution, the SVM rolls back account state and the
        // post-snapshot equals the pre-snapshot — which is the
        // correct meta shape (no net movement).
        const pre = this.#snapshotTxBalances(tx);
        const result: TransactionResultEnvelope = isVersioned(tx)
            ? this.#svm.sendVersionedTransaction(bytes)
            : this.#svm.sendLegacyTransaction(bytes);
        const post = this.#snapshotTxBalances(tx);

        const sig = result.signature;
        this.#sigCounts.set(sig, num_signatures);
        const clock = this.#svm.getClockInfo();
        this.#txStore.set(sig, {
            bytes: new Uint8Array(bytes),
            slot: clock.slot,
            preBalances: pre.balances,
            postBalances: post.balances,
            preTokenBalances: pre.tokenBalances,
            postTokenBalances: post.tokenBalances,
        });
        const version = isVersioned(tx) ? 0 : ("legacy" as const);

        return {
            signature: sig,
            slot: clock.slot,
            transaction: tx,
            meta: {
                err: result.status === "err" ? result.err : null,
                fee: result.fee,
                preBalances: pre.balances,
                postBalances: post.balances,
                innerInstructions: rawInnerInstructionsToApi(result.inner_instructions),
                logMessages: result.logs,
                preTokenBalances: pre.tokenBalances,
                postTokenBalances: post.tokenBalances,
                rewards: null,
                computeUnitsConsumed: result.compute_units_consumed,
                numSignatures: num_signatures,
                returnData: null,
            },
            blockTime: Math.floor(clock.unix_timestamp),
            version,
        };
    }

    async simulateTransaction(
        tx: Transaction | VersionedTransaction,
        _opts?: {
            commitment?: Commitment;
            sigVerify?: boolean;
            replaceRecentBlockhash?: boolean;
        },
    ): Promise<SimulationResult> {
        await this.#ensureAccountsLoaded(tx);
        const bytes = tx.serialize();
        enforceTxWireSize(bytes);
        const envelope: SimulationResultEnvelope = isVersioned(tx)
            ? this.#svm.simulateVersionedTransaction(bytes)
            : this.#svm.simulateLegacyTransaction(bytes);

        const meta = envelope.meta;

        const returnData = meta.return_data.program_id.length > 0
            ? {
                programId: encodeBase58(
                    new Uint8Array(meta.return_data.program_id),
                ),
                data: new Uint8Array(meta.return_data.data),
            }
            : null;

        const accounts: SimulationAccount[] | null = envelope.status === "ok"
            ? envelope.post_accounts
                .filter(
                    (entry: { pubkey: number[]; account?: SerializableAccount }) => entry.account != null,
                )
                .map(
                    (entry: { pubkey: number[]; account: SerializableAccount }) => ({
                        pubkey: encodeBase58(new Uint8Array(entry.pubkey)),
                        lamports: entry.account.lamports,
                        data: entry.account.data,
                        owner: encodeBase58(entry.account.owner),
                        executable: entry.account.executable,
                        rentEpoch: entry.account.rent_epoch,
                    }),
                )
            : null;

        return {
            err: envelope.status === "err" ? envelope.err : null,
            logs: meta.logs,
            accounts,
            loadedAccountsDataSize: null,
            returnData,
            unitsConsumed: meta.compute_units_consumed,
            fee: meta.fee,
            preBalances: meta.pre_balances ?? [],
            postBalances: meta.post_balances ?? [],
            preTokenBalances: [],
            postTokenBalances: [],
            loadedAddresses: null,
            innerInstructions: rawInnerInstructionsToApi(meta.inner_instructions),
        };
    }

    /**
     * Sets a token balance for an account, creating or overwriting the token
     * account data. Use this for testing to assume any token balance without
     * needing actual mints or token issuance.
     */
    setSPLTokenBalance(
        tokenAccount: PubkeyInput,
        mint: PubkeyInput,
        owner: PubkeyInput,
        amount: bigint,
        opts?: {
            delegate?: PubkeyInput;
            delegatedAmount?: bigint;
        },
    ): void {
        const mint_pk = toPubkey(mint);
        const is_wsol = mint_pk.toBase58() === WSOL_MINT_ADDRESS;
        const mint_account = this.#svm.getAccount(mint_pk.toBytes());
        const mint_owner_str = mint_account ? new PublicKey(mint_account.owner).toBase58() : TOKEN_PROGRAM_PUBKEY;
        const is_token_2022 = mint_owner_str === TOKEN_2022_PROGRAM_PUBKEY;
        // Token-2022 token accounts must carry the account-side extensions that
        // their mint's extensions mandate; otherwise programs that deserialize
        // them via StateWithExtensions (e.g. Whirlpool SwapV2) reject the bare
        // account with InvalidAccountData. ATAs always carry ImmutableOwner.
        const account_exts = is_token_2022 ? requiredAccountExtensions(mint_account?.data) : [];
        // Token-2022 accounts append an AccountType marker at offset 165, then TLV extensions.
        const ext_bytes = account_exts.reduce((n, e) => n + 4 + e.data.length, 0);
        const data_len = is_token_2022 ? TOKEN_ACCOUNT_SIZE + 1 + ext_bytes : TOKEN_ACCOUNT_SIZE;
        const data = new Uint8Array(data_len);
        const view = new DataView(data.buffer);

        data.set(mint_pk.toBytes(), 0); // mint at 0
        data.set(toPubkey(owner).toBytes(), 32); // owner at 32
        view.setBigUint64(64, amount, true); // amount at 64

        if (opts?.delegate) {
            view.setUint32(72, 1, true); // delegate: Some
            data.set(toPubkey(opts.delegate).toBytes(), 76); // delegate pubkey at 76
        } else {
            view.setUint32(72, 0, true); // delegate: None
        }
        data[108] = 1; // state: Initialized
        if (is_wsol) {
            view.setUint32(109, 1, true); // is_native: Some
            view.setBigUint64(113, BigInt(TOKEN_ACCOUNT_RENT_EXEMPTION), true); // rent_exempt_reserve at 113
        } else {
            view.setUint32(109, 0, true); // is_native: None
        }
        view.setBigUint64(121, opts?.delegatedAmount ?? 0n, true); // delegated_amount at 121
        view.setUint32(129, 0, true); // close_authority: None
        if (is_token_2022) {
            data[TOKEN_ACCOUNT_SIZE] = 2; // AccountType::Account
            let off = TOKEN_ACCOUNT_SIZE + 1;
            for (const ext of account_exts) {
                view.setUint16(off, ext.type, true); // extension type
                view.setUint16(off + 2, ext.data.length, true); // extension length
                data.set(ext.data, off + 4); // extension payload
                off += 4 + ext.data.length;
            }
        }

        const program_pk = is_token_2022
            ? new PublicKey(TOKEN_2022_PROGRAM_PUBKEY)
            : new PublicKey(TOKEN_PROGRAM_PUBKEY);
        const rent_lamports = TOKEN_ACCOUNT_RENT_EXEMPTION +
            (data_len - TOKEN_ACCOUNT_SIZE) * 6960; // per-byte rent for extensions
        this.#svm.setAccount(toPubkey(tokenAccount).toBytes(), {
            lamports: is_wsol ? Number(amount) + rent_lamports : rent_lamports,
            data,
            owner: program_pk.toBytes(),
            executable: false,
            rent_epoch: 0,
        });
    }

    /**
     * Inject a ready-to-use Address Lookup Table directly into the SVM, skipping
     * the on-chain create/extend (and its slot-activation delay). For litesvm
     * tests that need a v0 tx to reference many accounts under the size limit.
     * Returns the table address (caller-supplied or a deterministic default).
     */
    injectAddressLookupTable(
        address: PublicKey,
        addresses: PublicKey[],
        authority?: PublicKey,
    ): PublicKey {
        const data = buildAltAccountData(addresses, authority ?? address);
        this.#svm.setAccount(address.toBytes(), {
            lamports: 1_000_000_000,
            data,
            owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID.toBytes(),
            executable: false,
            rent_epoch: 0,
        });
        return address;
    }

    getTokenBalance(tokenAccount: PubkeyInput): bigint {
        const pk = toPubkey(tokenAccount);
        const existing = this.#svm.getAccount(pk.toBytes());
        if (!existing) {
            throw new Error(`Token account ${pk.toBase58()} does not exist`);
        }
        if (existing.data.length < TOKEN_ACCOUNT_SIZE) {
            throw new Error(
                `Invalid token account data length: ${existing.data.length}`,
            );
        }
        return new DataView(
            existing.data.buffer,
            existing.data.byteOffset,
            existing.data.byteLength,
        ).getBigUint64(64, true);
    }

    warpToSlot(slot: number): void {
        this.#svm.warpToSlot(slot);
        const now = Math.floor(Date.now() / 1000);
        const clock = this.#svm.getClockInfo();
        if (now > clock.unix_timestamp) {
            this.#svm.setClockInfo({ ...clock, unix_timestamp: now });
        }
    }

    async getSlot(commitment: Commitment = "finalized"): Promise<number> {
        return this.#rpc.getSlot(commitment);
    }

    async getSignaturesForAddress(
        address: PubkeyInput,
        opts?: { limit?: number; before?: string; until?: string },
    ): Promise<SignatureInfo[]> {
        const target = toPubkey(address).toBase58();
        const clock = this.#svm.getClockInfo();
        const parseUntilSlot = (s: string | undefined): bigint | null => {
            if (!s || !/^[0-9]+$/.test(s)) return null;
            try {
                return BigInt(s);
            } catch {
                return null;
            }
        };
        const until_slot = parseUntilSlot(opts?.until);

        // Scan locally-stored transactions for ones involving this address
        const local_sigs: SignatureInfo[] = [];
        for (const [sig, stored] of this.#txStore) {
            if (until_slot !== null && BigInt(stored.slot) < until_slot) continue;
            const tx = deserializeTransaction(stored.bytes);
            const keys = tx.staticAccountKeys.map((k: PublicKey) => k.toBase58());
            if (keys.includes(target)) {
                const result = this.#svm.getTransactionBySignature(decodeBase58(sig));
                local_sigs.push({
                    signature: sig,
                    slot: stored.slot,
                    err: result?.status === "err" ? result.err : null,
                    memo: null,
                    blockTime: Math.floor(clock.unix_timestamp),
                    confirmationStatus: "confirmed",
                });
            }
        }

        // Merge with RPC results. Skipped when auto-fetch is off so
        // tests that pre-populate the SVM (and have no real RPC behind
        // them) get back exactly the txs they sent locally.
        if (this.#autoFetch) {
            const rpc_opts = until_slot !== null ? { ...opts, until: undefined } : opts;
            const rpc_sigs = await this.#rpc.getSignaturesForAddress(
                address,
                rpc_opts,
            );
            const seen = new Set(local_sigs.map((s: SignatureInfo) => s.signature));
            for (const sig of rpc_sigs) {
                if (until_slot !== null && BigInt(sig.slot) < until_slot) continue;
                if (!seen.has(sig.signature)) {
                    local_sigs.push(sig);
                }
            }
        }

        // Sort by slot descending (most recent first)
        local_sigs.sort((a: SignatureInfo, b: SignatureInfo) => b.slot - a.slot);

        const limit = opts?.limit ?? 1000;
        return local_sigs.slice(0, limit);
    }

    async request(_args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown> {
        throw new Error(
            "Not implemented: LocalClient does not support raw RPC requests",
        );
    }

    /**
     * Historical block lookup isn't meaningful in LiteSVM (no block history is
     * kept by the forked simulator), so we delegate to the underlying RPC the
     * client was forked against. This keeps `getBlock(slot)` usable for
     * queries that need real-chain block metadata.
     */
    async getBlock(
        slot: number,
        opts?: { transactionDetails?: "full" | "signatures" | "none" },
    ): Promise<BlockResponse | null> {
        return this.#rpc.getBlock(slot, opts);
    }

    async warpToCurrentRpcSlot(
        commitment: Commitment = "finalized",
    ): Promise<void> {
        const slot = await this.#rpc.getSlot(commitment);
        this.#svm.warpToSlot(slot);
    }

    async ensureAccountKeysLoaded(accountKeys: PubkeyInput[]): Promise<void> {
        const accountsToFetch: PublicKey[] = [];
        for (const key of accountKeys) {
            const pk = toPubkey(key);
            const pkStr = pk.toBase58();
            if (!this.#loadedAccounts.has(pkStr) && !BUILTIN_PROGRAMS.has(pkStr)) {
                const existing = this.#svm.getAccount(pk.toBytes());
                if (!existing) accountsToFetch.push(pk);
                else this.#loadedAccounts.add(pkStr);
            }
        }
        if (accountsToFetch.length === 0) return;
        const BATCH_SIZE = 100;
        for (let i = 0; i < accountsToFetch.length; i += BATCH_SIZE) {
            const batch = accountsToFetch.slice(i, i + BATCH_SIZE);
            const accountMap = await this.#rpc.getMultipleAccounts(batch);
            const programsToLoad: PublicKey[] = [];
            for (const [pkStr, account] of accountMap) {
                if (account) {
                    const pk = new PublicKey(pkStr);
                    if (account.executable) programsToLoad.push(pk);
                    else {
                        this.#svm.setAccount(pk.toBytes(), account);
                        this.#loadedAccounts.add(pkStr);
                    }
                }
            }
            for (const programId of programsToLoad) {
                await this.#loadProgram(programId);
            }
        }
    }

    async deployProgram(
        elfBytes: Uint8Array,
        opts?: {
            upgradeAuthority?: SolanaSigner;
            payer?: SolanaSigner;
            programKeypair?: Keypair;
            computeUnitPrice?: bigint;
            immutable?: boolean;
        },
    ): Promise<DeployProgramResult> {
        const programKeypair = opts?.programKeypair ?? (await Keypair.generate());

        if (!opts?.upgradeAuthority) {
            this.#svm.addProgram(programKeypair.publicKey.toBytes(), elfBytes);
            return {
                id: programKeypair.publicKey,
                keypair: programKeypair,
                signatures: [],
            };
        }

        // Upgradeable: manually construct the two-account structure
        const { address: programDataAddress } = await findProgramAddress(
            [programKeypair.publicKey.toBytes()],
            BpfLoaderUpgradeable.programId,
        );

        // ProgramData account MUST be set first — LiteSVM's set_account for
        // upgradeable programs looks up the programdata account during load_program.
        const programDataData = new Uint8Array(
            PROGRAM_DATA_HEADER_SIZE + elfBytes.length,
        );
        const pdView = new DataView(programDataData.buffer);
        pdView.setUint32(0, 3, true); // ProgramData variant
        pdView.setBigUint64(4, BigInt(this.#svm.getClockInfo().slot), true);
        programDataData[12] = 1; // Some
        programDataData.set(opts.upgradeAuthority.getPublicKey().toBytes(), 13);
        programDataData.set(elfBytes, PROGRAM_DATA_HEADER_SIZE);

        this.#svm.setAccount(programDataAddress.toBytes(), {
            lamports: this.#svm.minimumBalanceForRentExemption(
                PROGRAM_DATA_HEADER_SIZE + elfBytes.length,
            ),
            data: programDataData,
            owner: BpfLoaderUpgradeable.programId.toBytes(),
            executable: false,
            rent_epoch: 0,
        });

        // Program account (36 bytes): enum tag 2 (Program) + programdata address
        const programAccountData = new Uint8Array(36);
        new DataView(programAccountData.buffer).setUint32(0, 2, true);
        programAccountData.set(programDataAddress.toBytes(), 4);

        this.#svm.setAccount(programKeypair.publicKey.toBytes(), {
            lamports: this.#svm.minimumBalanceForRentExemption(36),
            data: programAccountData,
            owner: BpfLoaderUpgradeable.programId.toBytes(),
            executable: true,
            rent_epoch: 0,
        });

        return {
            id: programKeypair.publicKey,
            keypair: programKeypair,
            programDataAddress,
            signatures: [],
        };
    }
}

export class RpcClient implements Client {
    #endpoint: string;

    constructor(endpoint: string) {
        this.#endpoint = endpoint.replace(/\/$/, "");
    }

    get endpoint(): string {
        return this.#endpoint;
    }

    async call<T>(method: string, params: unknown[]): Promise<T> {
        const payload = {
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method,
            params,
        };
        const res = await fetch(this.#endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error.message ?? "RPC error");
        return json.result as T;
    }

    async getAccount(pubkey: PubkeyInput): Promise<SerializableAccount | null> {
        const pk = toPubkey(pubkey);
        const result = await this.call<{ value: unknown }>("getAccountInfo", [
            pk.toBase58(),
            { encoding: "base64" },
        ]);
        return normalizeAccount(result.value);
    }

    /** Pure RPC has no sandbox to populate, so `loadAccounts` is just a
     *  thin alias for `getMultipleAccounts` — kept for `Client` interface
     *  parity with `LocalClient`. */
    async loadAccounts(
        pubkeys: PubkeyInput[],
    ): Promise<Map<string, SerializableAccount | null>> {
        return this.getMultipleAccounts(pubkeys);
    }

    async getMultipleAccounts(
        pubkeys: PubkeyInput[],
    ): Promise<Map<string, SerializableAccount | null>> {
        const addresses = pubkeys.map((pk) => toPubkey(pk).toBase58());
        const result = await this.call<{ value: unknown[] }>(
            "getMultipleAccounts",
            [addresses, { encoding: "base64" }],
        );
        const accountMap = new Map<string, SerializableAccount | null>();
        for (let i = 0; i < pubkeys.length; i++) {
            const account = normalizeAccount(result.value[i]);
            accountMap.set(toPubkey(pubkeys[i]).toBase58(), account);
        }
        return accountMap;
    }

    async getProgramData(programId: PubkeyInput): Promise<{
        programAccount: SerializableAccount | null;
        programDataAccount: SerializableAccount | null;
        programDataAddress: PublicKey | null;
    }> {
        const programAccount = await this.getAccount(programId);
        if (!programAccount || !programAccount.executable) {
            return {
                programAccount,
                programDataAccount: null,
                programDataAddress: null,
            };
        }
        const ownerStr = new PublicKey(programAccount.owner).toBase58();
        if (ownerStr === BpfLoaderUpgradeable.programId.toBase58()) {
            if (programAccount.data.length >= 36) {
                const programDataBytes = programAccount.data.slice(4, 36);
                const programDataAddress = new PublicKey(programDataBytes);
                const programDataAccount = await this.getAccount(programDataAddress);
                return { programAccount, programDataAccount, programDataAddress };
            }
        }
        return {
            programAccount,
            programDataAccount: null,
            programDataAddress: null,
        };
    }

    async getNativeBalance(pubkey: PubkeyInput): Promise<number> {
        const pk = toPubkey(pubkey);
        const result = await this.call<{
            context: { slot: number };
            value: number;
        }>("getBalance", [pk.toBase58(), { commitment: "confirmed" }]);
        return result.value;
    }

    async getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
        return this.call<number>("getMinimumBalanceForRentExemption", [
            dataLength,
            { commitment: "confirmed" },
        ]);
    }

    async getSPLTokenAccountBalance(
        mint: PubkeyInput,
        owner: PubkeyInput,
    ): Promise<SPLTokenAmount> {
        const ata = await getSPLAssociatedTokenAddress(
            toPubkey(mint),
            toPubkey(owner),
        );
        const account = await this.getAccount(ata);
        if (!account) {
            return { amount: "0", decimals: 0, uiAmount: 0, uiAmountString: "0" };
        }
        const result = await this.call<{
            context: { slot: number };
            value: SPLTokenAmount;
        }>("getTokenAccountBalance", [ata.toBase58(), { commitment: "confirmed" }]);
        return result.value;
    }

    async getSPLTokenAccountDelegate(
        mint: PubkeyInput,
        owner: PubkeyInput,
    ): Promise<SPLTokenAccountDelegate> {
        const ata = await getSPLAssociatedTokenAddress(
            toPubkey(mint),
            toPubkey(owner),
        );
        const account = await this.getAccount(ata);
        if (!account || account.data.length < TOKEN_ACCOUNT_SIZE) {
            return { delegate: null, delegatedAmount: 0n };
        }
        const view = new DataView(
            account.data.buffer,
            account.data.byteOffset,
            account.data.byteLength,
        );
        const hasDelegate = view.getUint32(72, true) === 1;
        if (!hasDelegate) {
            return { delegate: null, delegatedAmount: 0n };
        }
        const delegatePubkey = new PublicKey(account.data.slice(76, 108));
        const delegatedAmount = view.getBigUint64(121, true);
        return { delegate: delegatePubkey.toBase58(), delegatedAmount };
    }

    async latestBlockhash(): Promise<string> {
        // Fetch at "finalized" so the blockhash is present on every backend
        // node. A load-balanced RPC (e.g. Alchemy) may route the fetch and the
        // preflight to different nodes; a freshly "confirmed" blockhash can be
        // unknown to the preflight node, surfacing as "Blockhash not found".
        // Finalized blockhashes are universally known and still valid (~45s).
        const result = await this.getLatestBlockhash("finalized");
        return result.blockhash;
    }

    async getLatestBlockhash(
        commitment?: Commitment,
    ): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
        const result = await this.call<{
            context?: { slot: number };
            value?: { blockhash: string; lastValidBlockHeight: number };
            blockhash?: string;
            lastValidBlockHeight?: number;
        }>("getLatestBlockhash", [{ commitment: commitment ?? "confirmed" }]);
        if (result.value?.blockhash) return result.value;
        if (result.blockhash) {
            return {
                blockhash: result.blockhash,
                lastValidBlockHeight: result.lastValidBlockHeight ?? 0,
            };
        }
        throw new Error("RPC did not return a blockhash");
    }

    async getSlot(commitment: Commitment = "finalized"): Promise<number> {
        return this.call<number>("getSlot", [{ commitment }]);
    }

    async request(args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown> {
        return this.call<unknown>(args.method, args.params ?? []);
    }

    async getBlock(
        slot: number,
        opts?: { transactionDetails?: "full" | "signatures" | "none" },
    ): Promise<BlockResponse | null> {
        return this.call<BlockResponse | null>("getBlock", [
            slot,
            {
                encoding: "json",
                transactionDetails: opts?.transactionDetails ?? "full",
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            },
        ]);
    }

    async getTransaction(signature: string): Promise<TransactionResponse | null> {
        const resp = await this.call<
            {
                slot: number;
                transaction: [string, string] | null;
                meta: TransactionMeta | null;
                blockTime: number | null;
                version?: "legacy" | number;
            } | null
        >("getTransaction", [
            signature,
            {
                encoding: "base64",
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed",
            },
        ]);
        if (!resp) return null;

        let transaction: Transaction | VersionedTransaction | null = null;
        if (resp.transaction) {
            const txBytes = base64ToBytes(resp.transaction[0]);
            transaction = deserializeTransaction(txBytes);
        }

        if (resp.meta && transaction) {
            resp.meta.numSignatures = transaction.signatures.length;
        }

        return {
            signature,
            slot: resp.slot,
            transaction,
            meta: resp.meta,
            blockTime: resp.blockTime,
            version: resp.version,
        };
    }

    async getTransactions(
        signatures: string[],
    ): Promise<(TransactionResponse | null)[]> {
        return Promise.all(signatures.map((sig) => this.getTransaction(sig)));
    }

    async getSignaturesForAddress(
        address: PubkeyInput,
        opts?: { limit?: number; before?: string; until?: string },
    ): Promise<SignatureInfo[]> {
        const config: Record<string, unknown> = { commitment: "confirmed" };
        if (opts?.limit !== undefined) config.limit = opts.limit;
        if (opts?.before) config.before = opts.before;
        if (opts?.until) config.until = opts.until;
        return this.call<SignatureInfo[]>("getSignaturesForAddress", [
            toPubkey(address).toBase58(),
            config,
        ]);
    }

    async #getSignatureStatuses(
        signatures: string[],
    ): Promise<(SignatureStatus | null)[]> {
        const result = await this.call<{
            context: { slot: number };
            value: (SignatureStatus | null)[];
        }>("getSignatureStatuses", [signatures]);
        return result.value;
    }

    async sendRawTransaction(
        encodedTx: string,
        opts?: { skipPreflight?: boolean; preflightCommitment?: Commitment },
    ): Promise<string> {
        return this.call<string>("sendTransaction", [
            encodedTx,
            {
                encoding: "base64",
                skipPreflight: opts?.skipPreflight ?? false,
                preflightCommitment: opts?.preflightCommitment ?? "confirmed",
            },
        ]);
    }

    async requestAirdrop(pubkey: PubkeyInput, lamports: number): Promise<string> {
        const pk = toPubkey(pubkey);
        const signature = await this.call<string>("requestAirdrop", [
            pk.toBase58(),
            lamports,
        ]);
        await this.#confirmTransaction(signature, "confirmed", 60_000);
        return signature;
    }

    async getSupply(): Promise<SupplyValue> {
        const result = await this.call<{
            context: { slot: number };
            value: SupplyValue;
        }>("getSupply", [
            { commitment: "confirmed", excludeNonCirculatingAccountsList: false },
        ]);
        return result.value;
    }

    async getFeeForMessage(message: string): Promise<number | null> {
        const result = await this.call<{
            context: { slot: number };
            value: number | null;
        }>("getFeeForMessage", [message, { commitment: "confirmed" }]);
        return result.value;
    }

    async getRecentPrioritizationFees(
        addresses?: PubkeyInput[],
    ): Promise<PrioritizationFee[]> {
        const params: unknown[] = addresses ? [addresses.map((a) => toPubkey(a).toBase58())] : [[]];
        return this.call<PrioritizationFee[]>(
            "getRecentPrioritizationFees",
            params,
        );
    }

    async sendTransaction(
        tx: Transaction | VersionedTransaction,
        options?: {
            skipPreflight?: boolean;
            commitment?: Commitment;
            confirmationTimeout?: number;
        },
    ): Promise<TransactionResponse> {
        const commitment = options?.commitment ?? "confirmed";
        const timeout_ms = options?.confirmationTimeout ?? 60_000;

        const signature = await this.sendRawTransaction(tx.serializeBase64(), {
            skipPreflight: options?.skipPreflight,
            preflightCommitment: commitment,
        });

        await this.#confirmTransaction(signature, commitment, timeout_ms);
        const response = await this.getTransaction(signature);
        if (!response) {
            throw new Error(`Transaction ${signature} confirmed but not found`);
        }
        return response;
    }

    async simulateTransaction(
        tx: Transaction | VersionedTransaction,
        opts?: {
            commitment?: Commitment;
            sigVerify?: boolean;
            replaceRecentBlockhash?: boolean;
            includeInnerInstructions?: boolean;
        },
    ): Promise<SimulationResult> {
        const encoded = tx.serializeBase64();
        const result = await this.call<SimulateTransactionResult>(
            "simulateTransaction",
            [
                encoded,
                {
                    encoding: "base64",
                    commitment: opts?.commitment ?? "confirmed",
                    sigVerify: opts?.sigVerify ?? false,
                    replaceRecentBlockhash: opts?.replaceRecentBlockhash ?? false,
                    includeInnerInstructions: opts?.includeInnerInstructions ?? false,
                },
            ],
        );

        const value = result.value;

        // Static account keys for resolving account indices when mapping accounts back
        const staticKeys: PublicKey[] = isVersioned(tx) ? tx.staticAccountKeys : [];

        const returnData: SimulationReturnData | null = value.returnData
            ? {
                programId: value.returnData.programId,
                data: new Uint8Array(
                    Array.from(atob(value.returnData.data[0])).map((c) => c.charCodeAt(0)),
                ),
            }
            : null;

        const accounts: (SimulationAccount | null)[] | null = value.accounts
            ? value.accounts.map((acc, i) => {
                if (!acc) return null;
                const pubkey = i < staticKeys.length ? staticKeys[i].toBase58() : "";
                const data = acc.data[1] === "base64"
                    ? new Uint8Array(
                        Array.from(atob(acc.data[0])).map((c) => c.charCodeAt(0)),
                    )
                    : new Uint8Array();
                return {
                    pubkey,
                    lamports: acc.lamports,
                    data,
                    owner: acc.owner,
                    executable: acc.executable,
                    rentEpoch: acc.rentEpoch,
                };
            })
            : null;

        return {
            err: value.err ?? null,
            logs: value.logs ?? [],
            accounts,
            loadedAccountsDataSize: null,
            returnData,
            unitsConsumed: value.unitsConsumed ?? 0,
            fee: value.fee ?? 0,
            preBalances: value.preBalances ?? [],
            postBalances: value.postBalances ?? [],
            preTokenBalances: value.preTokenBalances ?? [],
            postTokenBalances: value.postTokenBalances ?? [],
            loadedAddresses: value.loadedAddresses ?? null,
            innerInstructions: value.innerInstructions ?? null,
        };
    }

    async #confirmTransaction(
        signature: string,
        commitment: Commitment = "confirmed",
        timeoutMs: number = 60_000,
    ): Promise<SignatureStatus> {
        const startTime = Date.now();
        const commitmentLevels = ["processed", "confirmed", "finalized"];
        const targetLevel = commitmentLevels.indexOf(commitment);

        while (Date.now() - startTime < timeoutMs) {
            const statuses = await this.#getSignatureStatuses([signature]);
            const status = statuses[0];

            if (status !== null) {
                if (status.err) {
                    return status;
                }

                const currentLevel = status.confirmationStatus
                    ? commitmentLevels.indexOf(status.confirmationStatus)
                    : -1;

                if (currentLevel >= targetLevel) {
                    return status;
                }
            }

            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
    }

    async deployProgram(
        elfBytes: Uint8Array,
        opts?: {
            upgradeAuthority?: SolanaSigner;
            payer?: SolanaSigner;
            programKeypair?: Keypair;
            computeUnitPrice?: bigint;
            immutable?: boolean;
        },
    ): Promise<DeployProgramResult> {
        const payer = opts?.payer;
        if (!payer) {
            throw new Error(
                "RpcClient.deployProgram requires opts.payer to sign transactions",
            );
        }

        const programKeypair = opts?.programKeypair ?? (await Keypair.generate());
        const authority = opts?.upgradeAuthority;
        const priceIxs: InstructionInput[] = opts?.computeUnitPrice !== undefined
            ? [ComputeBudgetProgram.setComputeUnitPrice(opts.computeUnitPrice)]
            : [];
        if (authority) {
            const result = await this.#deployUpgradeable(
                payer,
                programKeypair,
                elfBytes,
                authority,
                priceIxs,
                opts?.immutable,
            );
            return { ...result, keypair: programKeypair };
        }
        const result = await this.#deployNonUpgradeable(
            payer,
            programKeypair,
            elfBytes,
            priceIxs,
        );
        return { ...result, keypair: programKeypair };
    }

    async #deployUpgradeable(
        payer: SolanaSigner,
        programKeypair: Keypair,
        elfBytes: Uint8Array,
        authority: SolanaSigner,
        priceIxs: InstructionInput[] = [],
        immutable = false,
    ): Promise<{
        id: PublicKey;
        programDataAddress: PublicKey;
        signatures: string[];
    }> {
        const signatures: string[] = [];
        const payerPk = payer.getPublicKey();
        const authorityPk = authority.getPublicKey();
        const bufferKeypair = await Keypair.generate();
        const bufferSize = BUFFER_HEADER_SIZE + elfBytes.length;

        const bufferLamports = await this.getMinimumBalanceForRentExemption(
            bufferSize,
        );
        const blockhash1 = await this.latestBlockhash();

        const createBufferTx = new VersionedTransaction(
            MessageV0.fromInstructions({
                payerKey: payerPk,
                recentBlockhash: blockhash1,
                instructions: [
                    ...priceIxs,
                    SystemProgram.createAccount(
                        payerPk,
                        bufferKeypair.publicKey,
                        bufferLamports,
                        bufferSize,
                        BpfLoaderUpgradeable.programId,
                    ),
                    BpfLoaderUpgradeable.initializeBuffer(
                        bufferKeypair.publicKey,
                        authorityPk,
                    ),
                ],
            }),
        );
        await createBufferTx.sign([payer, bufferKeypair]);
        const createBufResult = await this.sendTransaction(createBufferTx);
        if (createBufResult.meta?.err) {
            throw new Error(
                `Failed to create buffer account: ${JSON.stringify(createBufResult.meta.err)}`,
            );
        }
        signatures.push(createBufResult.signature);

        const writeSigs = await chunkedWrite(
            elfBytes,
            payer,
            [authority],
            (offset, chunk) =>
                BpfLoaderUpgradeable.write(
                    bufferKeypair.publicKey,
                    authorityPk,
                    offset,
                    chunk,
                ),
            () => this.latestBlockhash(),
            (tx) => this.sendTransaction(tx),
            priceIxs,
        );
        signatures.push(...writeSigs);

        const { address: programDataAddress } = await findProgramAddress(
            [programKeypair.publicKey.toBytes()],
            BpfLoaderUpgradeable.programId,
        );

        const programDataSize = PROGRAM_DATA_HEADER_SIZE + elfBytes.length;
        const programLamports = await this.getMinimumBalanceForRentExemption(36);
        const deployBlockhash = await this.latestBlockhash();

        const deployTx = new VersionedTransaction(
            MessageV0.fromInstructions({
                payerKey: payerPk,
                recentBlockhash: deployBlockhash,
                instructions: [
                    ...priceIxs,
                    SystemProgram.createAccount(
                        payerPk,
                        programKeypair.publicKey,
                        programLamports,
                        36,
                        BpfLoaderUpgradeable.programId,
                    ),
                    BpfLoaderUpgradeable.deployWithMaxDataLen(
                        payerPk,
                        programDataAddress,
                        programKeypair.publicKey,
                        bufferKeypair.publicKey,
                        authorityPk,
                        programDataSize,
                    ),
                ],
            }),
        );
        await deployTx.sign([payer, programKeypair, authority]);
        const deployResult = await this.sendTransaction(deployTx);
        if (deployResult.meta?.err) {
            throw new Error(
                `Failed to deploy program: ${JSON.stringify(deployResult.meta.err)}`,
            );
        }
        signatures.push(deployResult.signature);

        if (immutable) {
            const finalizeBlockhash = await this.latestBlockhash();
            const finalizeTx = new VersionedTransaction(
                MessageV0.fromInstructions({
                    payerKey: payerPk,
                    recentBlockhash: finalizeBlockhash,
                    instructions: [
                        ...priceIxs,
                        BpfLoaderUpgradeable.setAuthority(programDataAddress, authorityPk),
                    ],
                }),
            );
            await finalizeTx.sign([payer, authority]);
            const finalizeResult = await this.sendTransaction(finalizeTx);
            if (finalizeResult.meta?.err) {
                throw new Error(
                    `Failed to finalize (make immutable) program: ${JSON.stringify(finalizeResult.meta.err)}`,
                );
            }
            signatures.push(finalizeResult.signature);
        }

        return { id: programKeypair.publicKey, programDataAddress, signatures };
    }

    async #deployNonUpgradeable(
        payer: SolanaSigner,
        programKeypair: Keypair,
        elfBytes: Uint8Array,
        priceIxs: InstructionInput[] = [],
    ): Promise<{ id: PublicKey; signatures: string[] }> {
        const signatures: string[] = [];
        const payerPk = payer.getPublicKey();
        const lamports = await this.getMinimumBalanceForRentExemption(
            elfBytes.length,
        );
        const blockhash = await this.latestBlockhash();

        const createTx = new VersionedTransaction(
            MessageV0.fromInstructions({
                payerKey: payerPk,
                recentBlockhash: blockhash,
                instructions: [
                    ...priceIxs,
                    SystemProgram.createAccount(
                        payerPk,
                        programKeypair.publicKey,
                        lamports,
                        elfBytes.length,
                        BpfLoader.programId,
                    ),
                ],
            }),
        );
        await createTx.sign([payer, programKeypair]);
        const createResult = await this.sendTransaction(createTx);
        if (createResult.meta?.err) {
            throw new Error(
                `Failed to create program account: ${JSON.stringify(createResult.meta.err)}`,
            );
        }
        signatures.push(createResult.signature);

        const writeSigs = await chunkedWrite(
            elfBytes,
            payer,
            [programKeypair],
            (offset, chunk) => BpfLoader.write(programKeypair.publicKey, offset, chunk),
            () => this.latestBlockhash(),
            (tx) => this.sendTransaction(tx),
            priceIxs,
        );
        signatures.push(...writeSigs);

        const finalizeBlockhash = await this.latestBlockhash();
        const finalizeTx = new VersionedTransaction(
            MessageV0.fromInstructions({
                payerKey: payerPk,
                recentBlockhash: finalizeBlockhash,
                instructions: [
                    ...priceIxs,
                    BpfLoader.finalize(programKeypair.publicKey),
                ],
            }),
        );
        await finalizeTx.sign([payer, programKeypair]);
        const finalizeResult = await this.sendTransaction(finalizeTx);
        if (finalizeResult.meta?.err) {
            throw new Error(
                `Failed to finalize program: ${JSON.stringify(finalizeResult.meta.err)}`,
            );
        }

        signatures.push(finalizeResult.signature);

        return { id: programKeypair.publicKey, signatures };
    }
}

/**
 * Create an Address Lookup Table on-chain and populate it with `addresses`,
 * via real CreateLookupTable + ExtendLookupTable instructions (works against
 * both litesvm and a real cluster). The payer is the table authority. Returns
 * the table address. Extend is chunked so each tx stays under the wire limit.
 *
 * Note: on a real cluster an ALT is only usable one slot after it is extended;
 * `SolChain.simulateAndSend` warps litesvm past that slot when given the ALT.
 */
export async function createAddressLookupTable(
    client: Client,
    payer: SolanaSigner,
    addresses: PublicKey[],
    opts?: { extendChunkSize?: number },
): Promise<PublicKey> {
    const payerPk = payer.getPublicKey();
    const recentSlot = await client.getSlot("finalized");
    const { instruction: createIx, lookupTableAddress } = await AddressLookupTableProgram
        .createLookupTable({ authority: payerPk, payer: payerPk, recentSlot });

    const send = async (ixs: InstructionInput[], label: string) => {
        const blockhash = await client.latestBlockhash();
        const msg = MessageV0.fromInstructions({
            payerKey: payerPk,
            recentBlockhash: blockhash,
            instructions: ixs,
        });
        const tx = new VersionedTransaction(msg);
        await tx.sign([payer]);
        const res = await client.sendTransaction(tx);
        if (res.meta?.err) {
            throw new Error(`${label} failed: ${JSON.stringify(res.meta.err)}`);
        }
    };

    await send([createIx], "createLookupTable");

    // Keep each extend under the 1232-byte tx limit: 32 bytes/address + ~150
    // bytes overhead → 20 addresses is a safe chunk.
    const chunk = opts?.extendChunkSize ?? 20;
    for (let i = 0; i < addresses.length; i += chunk) {
        const slice = addresses.slice(i, i + chunk);
        const extendIx = AddressLookupTableProgram.extendLookupTable({
            lookupTable: lookupTableAddress,
            authority: payerPk,
            payer: payerPk,
            addresses: slice,
        });
        await send([extendIx], `extendLookupTable[${i}]`);
    }
    return lookupTableAddress;
}
