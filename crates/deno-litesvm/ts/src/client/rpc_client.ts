import type { SerializableAccount } from "../litesvm.ts";
import {
    BpfLoader,
    BpfLoaderUpgradeable,
    chunkedWrite,
    ComputeBudgetProgram,
    decodeBase64,
    deserializeTransaction,
    findProgramAddress,
    getSPLAssociatedTokenAddress,
    InstructionInput,
    Keypair,
    MessageV0,
    PublicKey,
    SolanaSigner,
    SystemProgram,
    Transaction,
    VersionedTransaction,
} from "../solana.ts";
import { TOKEN_ACCOUNT_SIZE } from "../solana.ts";
import type {
    BlockResponse,
    Client,
    Commitment,
    DeployProgramResult,
    PrioritizationFee,
    PubkeyInput,
    SignatureInfo,
    SignatureStatus,
    SimulateTransactionResult,
    SimulationResult,
    SimulationReturnData,
    SimulationAccount,
    SPLTokenAccountDelegate,
    SPLTokenAmount,
    SupplyValue,
    TransactionMeta,
    TransactionResponse,
} from "./types.ts";
import { toPubkey } from "./types.ts";
import {
    BUFFER_HEADER_SIZE,
    isVersioned,
    normalizeAccount,
    PROGRAM_DATA_HEADER_SIZE,
    tokenProgramForMintAccount,
} from "./utils.ts";

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

    async getAccount(
        pubkey: PubkeyInput,
        _opts?: { localOnly?: boolean },
    ): Promise<SerializableAccount | null> {
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
    loadAccounts(
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
                const programDataAccount = await this.getAccount(
                    programDataAddress,
                );
                return {
                    programAccount,
                    programDataAccount,
                    programDataAddress,
                };
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

    getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
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
            return {
                amount: "0",
                decimals: 0,
                uiAmount: 0,
                uiAmountString: "0",
            };
        }
        const result = await this.call<{
            context: { slot: number };
            value: SPLTokenAmount;
        }>("getTokenAccountBalance", [ata.toBase58(), {
            commitment: "confirmed",
        }]);
        return result.value;
    }

    async getSPLTokenAccountDelegate(
        mint: PubkeyInput,
        owner: PubkeyInput,
    ): Promise<SPLTokenAccountDelegate> {
        // Detect Token-2022 from the mint's owner so the ATA derivation matches
        // where Token-2022 mints (PYUSD etc) live — otherwise the default
        // TokenkegQ ATA lookup misses any Token-2022 holder's delegate.
        const mint_pk = toPubkey(mint);
        const mint_acc = await this.getAccount(mint_pk);
        const token_program = tokenProgramForMintAccount(mint_acc);
        const ata = await getSPLAssociatedTokenAddress(
            mint_pk,
            toPubkey(owner),
            token_program,
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

    getSlot(commitment: Commitment = "finalized"): Promise<number> {
        return this.call<number>("getSlot", [{ commitment }]);
    }

    request(args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown> {
        return this.call<unknown>(args.method, args.params ?? []);
    }

    getBlock(
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

    async getTransaction(
        signature: string,
    ): Promise<TransactionResponse | null> {
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
            const txBytes = decodeBase64(resp.transaction[0]);
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

    getTransactions(
        signatures: string[],
    ): Promise<(TransactionResponse | null)[]> {
        return Promise.all(signatures.map((sig) => this.getTransaction(sig)));
    }

    getSignaturesForAddress(
        address: PubkeyInput,
        opts?: {
            limit?: number;
            before?: string;
            until?: string;
            localOnly?: boolean;
        },
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

    sendRawTransaction(
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

    async requestAirdrop(
        pubkey: PubkeyInput,
        lamports: number,
    ): Promise<string> {
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
            {
                commitment: "confirmed",
                excludeNonCirculatingAccountsList: false,
            },
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

    getRecentPrioritizationFees(
        addresses?: PubkeyInput[],
    ): Promise<PrioritizationFee[]> {
        const params: unknown[] = addresses
            ? [addresses.map((a) => toPubkey(a).toBase58())]
            : [[]];
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
                    replaceRecentBlockhash: opts?.replaceRecentBlockhash ??
                        false,
                    includeInnerInstructions: opts?.includeInnerInstructions ??
                        false,
                },
            ],
        );

        const value = result.value;

        // Static account keys for resolving account indices when mapping accounts back
        const staticKeys: PublicKey[] = isVersioned(tx)
            ? tx.staticAccountKeys
            : [];

        const returnData: SimulationReturnData | null = value.returnData
            ? {
                programId: value.returnData.programId,
                data: new Uint8Array(
                    Array.from(atob(value.returnData.data[0])).map((c) =>
                        c.charCodeAt(0)
                    ),
                ),
            }
            : null;

        const accounts: (SimulationAccount | null)[] | null = value.accounts
            ? value.accounts.map((acc, i) => {
                if (!acc) return null;
                const pubkey = i < staticKeys.length
                    ? staticKeys[i].toBase58()
                    : "";
                const data = acc.data[1] === "base64"
                    ? new Uint8Array(
                        Array.from(atob(acc.data[0])).map((c) =>
                            c.charCodeAt(0)
                        ),
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

        throw new Error(
            `Transaction confirmation timeout after ${timeoutMs}ms`,
        );
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

        const programKeypair = opts?.programKeypair ??
            (await Keypair.generate());
        const authority = opts?.upgradeAuthority;
        const priceIxs: InstructionInput[] =
            opts?.computeUnitPrice !== undefined
                ? [ComputeBudgetProgram.setComputeUnitPrice(
                    opts.computeUnitPrice,
                )]
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

    /**
     * Close a deployed upgradeable program, refunding its ProgramData rent to
     * `recipient` (default: payer). This permanently retires the program — the
     * address cannot be redeployed. The program's current upgrade authority
     * must sign, so this only works while the program is still upgradeable; an
     * immutable program (authority already dropped) has no authority and cannot
     * be closed. Useful to reclaim rent when a deploy needs to be unwound.
     */
    async closeProgram(opts: {
        programId: PublicKey | string;
        authority: SolanaSigner;
        payer?: SolanaSigner;
        recipient?: PublicKey | string;
        computeUnitPrice?: bigint;
    }): Promise<{ signature: string }> {
        const payer = opts.payer ?? opts.authority;
        const programId = typeof opts.programId === "string"
            ? new PublicKey(opts.programId)
            : opts.programId;
        const recipient = opts.recipient === undefined
            ? payer.getPublicKey()
            : (typeof opts.recipient === "string" ? new PublicKey(opts.recipient) : opts.recipient);

        const { address: programDataAddress } = await findProgramAddress(
            [programId.toBytes()],
            BpfLoaderUpgradeable.programId,
        );

        const priceIxs: InstructionInput[] = opts.computeUnitPrice !== undefined
            ? [ComputeBudgetProgram.setComputeUnitPrice(opts.computeUnitPrice)]
            : [];

        const blockhash = await this.latestBlockhash();
        const tx = new VersionedTransaction(
            MessageV0.fromInstructions({
                payerKey: payer.getPublicKey(),
                recentBlockhash: blockhash,
                instructions: [
                    ...priceIxs,
                    BpfLoaderUpgradeable.close(
                        programDataAddress,
                        recipient,
                        opts.authority.getPublicKey(),
                        programId,
                    ),
                ],
            }),
        );

        // Dedupe signers: payer and authority may be the same key.
        const signers = payer.getPublicKey().toBase58() === opts.authority.getPublicKey().toBase58()
            ? [payer]
            : [payer, opts.authority];
        await tx.sign(signers);

        const result = await this.sendTransaction(tx);
        if (result.meta?.err) {
            throw new Error(
                `Failed to close program: ${JSON.stringify(result.meta.err)}`,
            );
        }
        return { signature: result.signature };
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
                `Failed to create buffer account: ${
                    JSON.stringify(createBufResult.meta.err)
                }`,
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
        const programLamports = await this.getMinimumBalanceForRentExemption(
            36,
        );
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
                `Failed to deploy program: ${
                    JSON.stringify(deployResult.meta.err)
                }`,
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
                        BpfLoaderUpgradeable.setAuthority(
                            programDataAddress,
                            authorityPk,
                        ),
                    ],
                }),
            );
            await finalizeTx.sign([payer, authority]);
            const finalizeResult = await this.sendTransaction(finalizeTx);
            if (finalizeResult.meta?.err) {
                throw new Error(
                    `Failed to finalize (make immutable) program: ${
                        JSON.stringify(finalizeResult.meta.err)
                    }`,
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
                `Failed to create program account: ${
                    JSON.stringify(createResult.meta.err)
                }`,
            );
        }
        signatures.push(createResult.signature);

        const writeSigs = await chunkedWrite(
            elfBytes,
            payer,
            [programKeypair],
            (offset, chunk) =>
                BpfLoader.write(programKeypair.publicKey, offset, chunk),
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
                `Failed to finalize program: ${
                    JSON.stringify(finalizeResult.meta.err)
                }`,
            );
        }

        signatures.push(finalizeResult.signature);

        return { id: programKeypair.publicKey, signatures };
    }
}
