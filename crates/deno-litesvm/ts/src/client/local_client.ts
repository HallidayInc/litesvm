import { LiteSvm } from "../litesvm.ts";
import type {
    SerializableAccount,
    SimulationResultEnvelope,
    TransactionResultEnvelope,
    TransactionResultErr,
} from "../litesvm.ts";
import type { InstructionInput } from "../solana.ts";
import {
    ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    AddressLookupTableProgram,
    BPF_LOADER_UPGRADEABLE_ID,
    BPF_LOADER_V1_ID,
    BPF_LOADER_V2_ID,
    BUILTIN_PROGRAMS,
    buildAltAccountData,
    BpfLoaderUpgradeable,
    decodeBase58,
    deserializeTransaction,
    encodeBase58,
    findProgramAddress,
    getSPLAssociatedTokenAddress,
    Keypair,
    LOADER_V4_ID,
    MessageV0,
    parseAltAccount,
    PublicKey,
    SolanaSigner,
    TOKEN_2022_PROGRAM_PUBKEY,
    TOKEN_ACCOUNT_RENT_EXEMPTION,
    TOKEN_ACCOUNT_SIZE,
    TOKEN_PROGRAM_PUBKEY,
    Transaction,
    VersionedTransaction,
    WSOL_MINT_ADDRESS,
} from "../solana.ts";
import { parseTokenAccountData } from "../solana.ts";
import { RpcClient } from "./rpc_client.ts";
import type {
    BlockResponse,
    Client,
    Commitment,
    DeployProgramResult,
    PrioritizationFee,
    PubkeyInput,
    SignatureInfo,
    SimulationAccount,
    SimulationResult,
    SPLTokenAccountDelegate,
    SPLTokenAmount,
    SPLTokenBalance,
    TransactionResponse,
} from "./types.ts";
import { rawInnerInstructionsToApi, toPubkey } from "./types.ts";
import {
    altKeysFromIxs,
    altKeysFromTx,
    enforceTxWireSize,
    ensureLookupTableCoverage,
    isVersioned,
    MAX_TX_WIRE_SIZE,
    PROGRAM_DATA_HEADER_SIZE,
    requiredAccountExtensions,
    resolveLookupTables,
    tokenProgramForMintAccount,
} from "./utils.ts";

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

    latestBlockhash(): Promise<string> {
        return Promise.resolve(this.#svm.latestBlockhashString());
    }

    requestAirdrop(pubkey: PubkeyInput, lamports: number): Promise<string> {
        const pk = toPubkey(pubkey);
        this.#svm.expireBlockhash();
        this.#svm.airdrop(pk.toBytes(), lamports);
        const rand = crypto.getRandomValues(new Uint8Array(64));
        return Promise.resolve(encodeBase58(rand));
    }

    async getAccount(
        pubkey: PubkeyInput,
        opts?: { localOnly?: boolean },
    ): Promise<SerializableAccount | null> {
        const pk = toPubkey(pubkey);

        const localAccount = this.#svm.getAccount(pk.toBytes());
        if (localAccount) return localAccount;

        // localOnly: skip the devnet RPC fallback (used for SPW-derived
        // accounts that only ever exist in the local SVM — e.g. completion
        // event-page reads — so a miss returns null fast instead of a slow
        // round-trip that can never succeed).
        if (this.#autoFetch && !opts?.localOnly) {
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
        const token_program = tokenProgramForMintAccount(mint_acc);
        const ata = await getSPLAssociatedTokenAddress(
            mint_pk,
            toPubkey(owner),
            token_program,
        );
        const account = this.svm.getAccount(ata.toBytes());
        if (!account || account.data.length < TOKEN_ACCOUNT_SIZE) {
            return {
                amount: "0",
                decimals: 0,
                uiAmount: 0,
                uiAmountString: "0",
            };
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
        // Detect Token-2022 from the mint's owner so the ATA derivation matches
        // where Token-2022 mints (PYUSD etc) live — otherwise the default
        // TokenkegQ ATA lookup misses any Token-2022 holder's delegate.
        const mint_pk = toPubkey(mint);
        const mint_acc = this.svm.getAccount(mint_pk.toBytes());
        const token_program = tokenProgramForMintAccount(mint_acc);
        const ata = await getSPLAssociatedTokenAddress(
            mint_pk,
            toPubkey(owner),
            token_program,
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

    getTransaction(signature: string): Promise<TransactionResponse | null> {
        let sigBytes: Uint8Array;
        try {
            sigBytes = decodeBase58(signature);
        } catch {
            return Promise.resolve(null);
        }
        if (sigBytes.length !== 64) return Promise.resolve(null);

        const result = this.#svm.getTransactionBySignature(sigBytes);

        if (result) {
            const clock = this.#svm.getClockInfo();
            const isOk = result.status === "ok";

            const stored = this.#txStore.get(signature);
            const transaction = stored
                ? deserializeTransaction(stored.bytes)
                : null;
            const version = transaction instanceof VersionedTransaction
                ? 0
                : ("legacy" as const);

            // pre/post balance arrays + token balances come from the
            // snapshot we took in `sendTransaction`. They're absent
            // only for txs replayed before this client was rev'd; we
            // fall back to empty/null in that case (same as before).
            return Promise.resolve({
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
            });
        }

        return this.#rpc.getTransaction(signature);
    }

    getTransactions(
        signatures: string[],
    ): Promise<(TransactionResponse | null)[]> {
        return Promise.all(signatures.map((sig) => this.getTransaction(sig)));
    }

    getRecentPrioritizationFees(
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
                        this.#svm.setAccount(
                            lookup.accountKey.toBytes(),
                            altAccount,
                        );
                        this.#loadedAccounts.add(altKeyStr);
                    }
                    altData = altAccount.data;
                }
                const altAddresses = parseAltAccount(altData);
                for (const idx of lookup.writableIndexes) {
                    if (idx < altAddresses.length) {
                        accountKeys.push(altAddresses[idx]);
                    }
                }
                for (const idx of lookup.readonlyIndexes) {
                    if (idx < altAddresses.length) {
                        accountKeys.push(altAddresses[idx]);
                    }
                }
            }
        }

        const accountsToFetch: PublicKey[] = [];
        for (const pk of accountKeys) {
            const pkStr = pk.toBase58();
            if (
                !this.#loadedAccounts.has(pkStr) && !BUILTIN_PROGRAMS.has(pkStr)
            ) {
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

        const { programAccount, programDataAccount, programDataAddress } =
            await this.#rpc.getProgramData(programId);

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

            const elfBytes = programDataAccount.data.slice(
                PROGRAM_DATA_HEADER_SIZE,
            );
            this.#svm.addProgram(programId.toBytes(), elfBytes);
            this.#svm.setAccount(
                programDataAddress.toBytes(),
                programDataAccount,
            );
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
            const ui_amount = decimals > 0
                ? Number(amount_n) / Math.pow(10, decimals)
                : Number(amount_n);
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
                innerInstructions: rawInnerInstructionsToApi(
                    result.inner_instructions,
                ),
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
                    (
                        entry: {
                            pubkey: number[];
                            account?: SerializableAccount;
                        },
                    ) => entry.account != null,
                )
                .map(
                    (
                        entry: {
                            pubkey: number[];
                            account: SerializableAccount;
                        },
                    ) => ({
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
            innerInstructions: rawInnerInstructionsToApi(
                meta.inner_instructions,
            ),
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
        const mint_owner_str = mint_account
            ? new PublicKey(mint_account.owner).toBase58()
            : TOKEN_PROGRAM_PUBKEY;
        const is_token_2022 = mint_owner_str === TOKEN_2022_PROGRAM_PUBKEY;
        // Token-2022 token accounts must carry the account-side extensions that
        // their mint's extensions mandate; otherwise programs that deserialize
        // them via StateWithExtensions (e.g. Whirlpool SwapV2) reject the bare
        // account with InvalidAccountData. ATAs always carry ImmutableOwner.
        const account_exts = is_token_2022
            ? requiredAccountExtensions(mint_account?.data)
            : [];
        // Token-2022 accounts append an AccountType marker at offset 165, then TLV extensions.
        const ext_bytes = account_exts.reduce(
            (n, e) => n + 4 + e.data.length,
            0,
        );
        const data_len = is_token_2022
            ? TOKEN_ACCOUNT_SIZE + 1 + ext_bytes
            : TOKEN_ACCOUNT_SIZE;
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

    async createLookupTable(
        payer: SolanaSigner,
        addresses: PublicKey[],
    ): Promise<PublicKey> {
        const kp = await Keypair.generate();
        const address = kp.publicKey;
        const authority = payer.getPublicKey();
        const current_slot = this.#svm.getClockInfo().slot;
        const data = buildAltAccountData(
            addresses,
            authority,
            current_slot,
        );
        this.#svm.setAccount(address.toBytes(), {
            lamports: 1_000_000_000,
            data,
            owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID.toBytes(),
            executable: false,
            rent_epoch: 0,
        });
        this.#svm.warpToSlot(current_slot + 1);
        return address;
    }

    async resolveLookupTables(
        lookupTables: PublicKey[],
        opts?: { label?: string; warmup?: boolean },
    ) {
        const result = await resolveLookupTables(
            lookupTables,
            (lookupTable) => this.getAccount(lookupTable),
            opts?.label,
        );
        if (opts?.warmup !== false && result.maxExtendedSlot > 0n) {
            this.warpToSlot(Number(result.maxExtendedSlot + 1n));
        }
        return result;
    }

    async exceedsWireLimit(
        payer: SolanaSigner,
        instructions: InstructionInput[],
        opts?: {
            lookupTables?: PublicKey[];
            extraSigners?: SolanaSigner[];
            label?: string;
            maxWireSize?: number;
            warmup?: boolean;
        },
    ): Promise<boolean> {
        const { resolved } = await this.resolveLookupTables(
            opts?.lookupTables ?? [],
            {
                label: opts?.label ?? "exceedsWireLimit",
                warmup: opts?.warmup,
            },
        );
        const msg = MessageV0.fromInstructionsWithAlts({
            payerKey: payer.getPublicKey(),
            recentBlockhash: await this.latestBlockhash(),
            instructions,
            altLookupsResolved: resolved,
        });
        const tx = new VersionedTransaction(msg);
        await tx.sign([payer, ...(opts?.extraSigners ?? [])]);
        return tx.serialize().length > (opts?.maxWireSize ?? MAX_TX_WIRE_SIZE);
    }

    async autoAlt(
        payer: SolanaSigner,
        tx: VersionedTransaction,
        instructions: InstructionInput[],
        opts?: { maxWireSize?: number },
    ) {
        if (tx.serialize().length <= (opts?.maxWireSize ?? MAX_TX_WIRE_SIZE)) {
            return null;
        }
        const addresses = altKeysFromTx(tx, instructions);
        if (addresses.length === 0) return null;
        return {
            accountKey: await this.createLookupTable(payer, addresses),
            addresses,
        };
    }

    async ensureLookupTableInstructionCoverage(
        payer: SolanaSigner,
        lookupTables: PublicKey[],
        instructions: InstructionInput[],
    ): Promise<PublicKey[]> {
        return await ensureLookupTableCoverage(
            lookupTables,
            altKeysFromIxs(instructions),
            (lookupTable) => this.getAccount(lookupTable),
            (missing) => this.createLookupTable(payer, missing),
        );
    }

    async deactivateLookupTable(
        authority: SolanaSigner,
        lookupTable: PublicKey,
    ): Promise<string> {
        const authority_pk = authority.getPublicKey();
        const ix = AddressLookupTableProgram.deactivateLookupTable({
            lookupTable,
            authority: authority_pk,
        });
        const blockhash = await this.latestBlockhash();
        const msg = MessageV0.fromInstructions({
            payerKey: authority_pk,
            recentBlockhash: blockhash,
            instructions: [ix],
        });
        const tx = new VersionedTransaction(msg);
        await tx.sign([authority]);
        const res = await this.sendTransaction(tx);
        if (res.meta?.err) {
            throw new Error(
                `deactivateLookupTable failed: ${JSON.stringify(res.meta.err)}`,
            );
        }
        return res.signature;
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

    getSlot(commitment: Commitment = "finalized"): Promise<number> {
        return this.#rpc.getSlot(commitment);
    }

    async getSignaturesForAddress(
        address: PubkeyInput,
        opts?: {
            limit?: number;
            before?: string;
            until?: string;
            localOnly?: boolean;
        },
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
            if (until_slot !== null && BigInt(stored.slot) < until_slot) {
                continue;
            }
            const tx = deserializeTransaction(stored.bytes);
            let keys = tx.staticAccountKeys.map((k: PublicKey) => k.toBase58());
            // A v0 tx may reference `target` only through an address lookup
            // table, leaving it out of the static keys. Real clusters index
            // signatures by every touched account (ALT-loaded included), so
            // resolve the ALTs and match against the full account set.
            if (
                !keys.includes(target) &&
                tx instanceof VersionedTransaction &&
                tx.addressTableLookups.length > 0
            ) {
                try {
                    const resolved = new Map<string, PublicKey[]>();
                    for (const lookup of tx.addressTableLookups) {
                        const acc = this.#svm.getAccount(
                            lookup.accountKey.toBytes(),
                        );
                        if (!acc) continue;
                        resolved.set(
                            lookup.accountKey.toBase58(),
                            parseAltAccount(acc.data),
                        );
                    }
                    keys = tx.resolveAllAccounts(resolved).map((k) =>
                        k.toBase58()
                    );
                } catch {
                    // best-effort; fall back to the static-key match
                }
            }
            if (keys.includes(target)) {
                const result = this.#svm.getTransactionBySignature(
                    decodeBase58(sig),
                );
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

        // Merge with RPC results. Skipped when auto-fetch is off (tests that
        // pre-populate the SVM and have no real RPC behind them) or when the
        // caller requests localOnly (SPW-derived addresses whose signatures
        // only exist locally — avoids a slow devnet round-trip in completion
        // polling).
        if (this.#autoFetch && !opts?.localOnly) {
            const rpc_opts = until_slot !== null
                ? { ...opts, until: undefined }
                : opts;
            const rpc_sigs = await this.#rpc.getSignaturesForAddress(
                address,
                rpc_opts,
            );
            const seen = new Set(
                local_sigs.map((s: SignatureInfo) => s.signature),
            );
            for (const sig of rpc_sigs) {
                if (until_slot !== null && BigInt(sig.slot) < until_slot) {
                    continue;
                }
                if (!seen.has(sig.signature)) {
                    local_sigs.push(sig);
                }
            }
        }

        // Sort by slot descending (most recent first)
        local_sigs.sort((a: SignatureInfo, b: SignatureInfo) =>
            b.slot - a.slot
        );

        const limit = opts?.limit ?? 1000;
        return local_sigs.slice(0, limit);
    }

    request(_args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown> {
        return Promise.reject(
            new Error(
                "Not implemented: LocalClient does not support raw RPC requests",
            ),
        );
    }

    /**
     * Historical block lookup isn't meaningful in LiteSVM (no block history is
     * kept by the forked simulator), so we delegate to the underlying RPC the
     * client was forked against. This keeps `getBlock(slot)` usable for
     * queries that need real-chain block metadata.
     */
    getBlock(
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
            if (
                !this.#loadedAccounts.has(pkStr) && !BUILTIN_PROGRAMS.has(pkStr)
            ) {
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
        const programKeypair = opts?.programKeypair ??
            (await Keypair.generate());

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
        // Mirror the on-chain immutable outcome: an immutable deploy drops the
        // upgrade authority (Option::None at offset 12); otherwise store
        // Some(authority) with the pubkey at offset 13.
        if (opts.immutable) {
            programDataData[12] = 0; // None → immutable
        } else {
            programDataData[12] = 1; // Some
            programDataData.set(opts.upgradeAuthority.getPublicKey().toBytes(), 13);
        }
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
