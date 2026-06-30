const { dlopen } = Deno;

function resolveLib(): URL {
    const target = Deno.build.target;
    const ext = Deno.build.os === "darwin" ? "dylib" : "so";
    return new URL(`../../litesvm_deno.${target}.${ext}`, import.meta.url);
}

const { symbols } = dlopen(resolveLib(), {
    create_default: {
        parameters: [],
        result: "u32",
        nonblocking: false,
    },
    create_basic: {
        parameters: [],
        result: "u32",
        nonblocking: false,
    },
    dispose: {
        parameters: ["u32"],
        result: "void",
        nonblocking: false,
    },
    set_default_programs: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    set_precompiles: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    set_builtins: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    set_sysvars: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    latest_blockhash: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    expire_blockhash: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    airdrop: {
        parameters: ["u32", "buffer", "usize", "u64"],
        result: "pointer",
        nonblocking: false,
    },
    get_account: {
        parameters: ["u32", "buffer", "usize"],
        result: "pointer",
        nonblocking: false,
    },
    set_account: {
        parameters: ["u32", "buffer", "usize", "pointer"],
        result: "pointer",
        nonblocking: false,
    },
    add_program: {
        parameters: ["u32", "buffer", "usize", "buffer", "usize"],
        result: "pointer",
        nonblocking: false,
    },
    send_legacy_transaction: {
        parameters: ["u32", "buffer", "usize"],
        result: "pointer",
        nonblocking: false,
    },
    send_versioned_transaction: {
        parameters: ["u32", "buffer", "usize"],
        result: "pointer",
        nonblocking: false,
    },
    simulate_legacy_transaction: {
        parameters: ["u32", "buffer", "usize"],
        result: "pointer",
        nonblocking: false,
    },
    simulate_versioned_transaction: {
        parameters: ["u32", "buffer", "usize"],
        result: "pointer",
        nonblocking: false,
    },
    set_transaction_history: {
        parameters: ["u32", "u64"],
        result: "pointer",
        nonblocking: false,
    },
    minimum_balance_for_rent_exemption: {
        parameters: ["u32", "u64"],
        result: "pointer",
        nonblocking: false,
    },
    latest_blockhash_string: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    get_sysvar_clock: {
        parameters: ["u32"],
        result: "pointer",
        nonblocking: false,
    },
    set_sysvar_clock: {
        // handle, slot, epoch, unix_timestamp, leader_schedule_epoch, epoch_start_timestamp
        parameters: ["u32", "u64", "u64", "i64", "u64", "i64"],
        result: "pointer",
        nonblocking: false,
    },
    warp_to_slot: {
        parameters: ["u32", "u64"],
        result: "pointer",
        nonblocking: false,
    },
    get_transaction_by_sig: {
        parameters: ["u32", "buffer", "usize"],
        result: "pointer",
        nonblocking: false,
    },
});

const decoder = new TextDecoder();

function decodeResult<T>(ptr: Deno.PointerObject | null): T {
    if (ptr === null) throw new Error("LiteSVM returned null pointer");
    const view = new Deno.UnsafePointerView(ptr);
    const len = view.getUint32(0);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = view.getUint8(4 + i);
    return JSON.parse(decoder.decode(bytes)) as T;
}

export interface SerializableAccount {
    lamports: number;
    data: Uint8Array;
    owner: Uint8Array;
    executable: boolean;
    rent_epoch: number;
}

/**
 * FFI-level inner instruction as emitted by the Rust side's serde JSON.
 * Mirrors `solana_message::inner_instruction::InnerInstruction`, which uses
 * `#[serde(rename_all = "camelCase")]` and wraps `accounts` / `data` with
 * `#[serde(with = "solana_short_vec")]`.
 *
 *   pub struct InnerInstruction {
 *       pub instruction: CompiledInstruction,
 *       pub stack_height: u8,
 *   }
 *   pub struct CompiledInstruction {
 *       pub program_id_index: u8,
 *       #[serde(with = "solana_short_vec")] pub accounts: Vec<u8>,
 *       #[serde(with = "solana_short_vec")] pub data: Vec<u8>,
 *   }
 *
 * Wire format after serde_json:
 *
 *   {
 *     "instruction": {
 *       "programIdIndex": 5,
 *       "accounts": [ [<shortU16_len_bytes>], 0, 1, 2 ],
 *       "data":     [ [<shortU16_len_bytes>], 10, 20, 30 ]
 *     },
 *     "stackHeight": 2
 *   }
 *
 * The leading element of each `accounts` / `data` array is the ShortU16-
 * encoded length (a nested 1–3-byte array) — callers must drop it to get
 * the actual byte payload.
 */
export interface RawCompiledInstruction {
    programIdIndex: number;
    accounts: unknown[];
    data: unknown[];
}

export interface InnerInstruction {
    instruction: RawCompiledInstruction;
    stackHeight: number;
}

export interface TransactionReturnData {
    program_id: Uint8Array;
    data: Uint8Array;
}

export interface TransactionMetadata {
    signature: Uint8Array;
    logs: string[];
    inner_instructions: InnerInstruction[][];
    compute_units_consumed: number;
    return_data: TransactionReturnData;
    fee: number;
}

export interface FailedTransactionMetadata {
    err: TransactionError;
    meta: TransactionMetadata;
}

export type TransactionError =
    | { InstructionError: [number, InstructionError] }
    | { DuplicateInstruction: number }
    | { InsufficientFundsForRent: { account_index: number } }
    | string;

export type InstructionError =
    | { Custom: number }
    | "GenericError"
    | "InvalidArgument"
    | "InvalidInstructionData"
    | "InvalidAccountData"
    | "AccountDataTooSmall"
    | "InsufficientFunds"
    | "IncorrectProgramId"
    | "MissingRequiredSignature"
    | "AccountAlreadyInitialized"
    | "UninitializedAccount"
    | "NotEnoughAccountKeys"
    | "AccountBorrowFailed"
    | "MaxSeedLengthExceeded"
    | "InvalidSeeds"
    | string;

export interface TransactionResultOk {
    status: "ok";
    signature: string;
    logs: string[];
    inner_instructions: InnerInstruction[][];
    compute_units_consumed: number;
    return_data: { program_id: number[]; data: number[] };
    fee: number;
}
export interface TransactionResultErr {
    status: "err";
    err: TransactionError;
    signature: string;
    logs: string[];
    inner_instructions: InnerInstruction[][];
    compute_units_consumed: number;
    return_data: { program_id: number[]; data: number[] };
    fee: number;
}

export type TransactionResultEnvelope =
    | TransactionResultOk
    | TransactionResultErr;

export interface SimulationMeta {
    signature: string;
    logs: string[];
    inner_instructions: InnerInstruction[][];
    compute_units_consumed: number;
    return_data: { program_id: number[]; data: number[] };
    fee: number;
    pre_balances?: number[];
    post_balances?: number[];
}

export interface SimulationResultOk {
    status: "ok";
    meta: SimulationMeta;
    post_accounts: { pubkey: number[]; account: SerializableAccount }[];
}

export interface SimulationResultErr {
    status: "err";
    err: TransactionError;
    meta: SimulationMeta;
}

export type SimulationResultEnvelope = SimulationResultOk | SimulationResultErr;

export interface ClockInfo {
    slot: number;
    epoch: number;
    unix_timestamp: number;
    leader_schedule_epoch: number;
    epoch_start_timestamp: number;
}

export interface EpochScheduleInfo {
    slots_per_epoch: number;
    leader_schedule_slot_offset: number;
    warmup: boolean;
    first_normal_epoch: number;
    first_normal_slot: number;
}

interface SerializableAccountJson {
    lamports: number;
    data: number[];
    owner: number[];
    executable: boolean;
    rent_epoch: number;
}

function convertAccountFromJson(
    account: SerializableAccountJson | null | undefined,
): SerializableAccount | null {
    if (account == null) return null;
    return {
        lamports: account.lamports,
        data: new Uint8Array(account.data),
        owner: new Uint8Array(account.owner),
        executable: account.executable,
        rent_epoch: account.rent_epoch,
    };
}

/** The Rust FFI returns TransactionResultErr with a nested `meta` field.
 *  Flatten it so the TS type has all fields at the top level. */
// deno-lint-ignore no-explicit-any
function flattenTxResult(raw: any): TransactionResultEnvelope {
    if (raw.status === "err" && raw.meta) {
        const { meta, ...rest } = raw;
        return { ...rest, ...meta };
    }
    return raw;
}

function unwrapVoid(result: { error?: string | null }): void {
    if (result.error) throw new Error(result.error);
}

function unwrapValue<T>(result: { value?: T; error?: string | null }): T {
    if (result.error) throw new Error(result.error);
    if (result.value === undefined) {
        throw new Error("LiteSVM binding returned no value");
    }
    return result.value;
}

function unwrapOptionalValue<T>(result: {
    value?: T | null;
    error?: string | null;
}): T | null {
    if (result.error) throw new Error(result.error);
    return result.value ?? null;
}

export class LiteSvm {
    #handle: number;

    constructor(opts: { basic?: boolean } = {}) {
        this.#handle = opts.basic
            ? symbols.create_default()
            : symbols.create_basic();
    }

    dispose(): void {
        symbols.dispose(this.#handle);
    }

    latestBlockhash(): Uint8Array {
        return unwrapValue(
            decodeResult<{ value?: Uint8Array; error?: string | null }>(
                symbols.latest_blockhash(this.#handle),
            ),
        );
    }

    latestBlockhashString(): string {
        return unwrapValue(
            decodeResult<{ value?: string; error?: string | null }>(
                symbols.latest_blockhash_string(this.#handle),
            ),
        );
    }

    expireBlockhash(): void {
        unwrapVoid(decodeResult(symbols.expire_blockhash(this.#handle)));
    }

    setDefaultPrograms(): void {
        unwrapVoid(decodeResult(symbols.set_default_programs(this.#handle)));
    }

    setPrecompiles(): void {
        unwrapVoid(decodeResult(symbols.set_precompiles(this.#handle)));
    }

    setBuiltins(): void {
        unwrapVoid(decodeResult(symbols.set_builtins(this.#handle)));
    }

    setSysvars(): void {
        unwrapVoid(decodeResult(symbols.set_sysvars(this.#handle)));
    }

    airdrop(pubkey: Uint8Array, lamports: bigint | number): void {
        const lamportNum = typeof lamports === "bigint"
            ? Number(lamports)
            : lamports;
        const pubkeyBuf = new Uint8Array(pubkey);
        unwrapVoid(
            decodeResult(
                symbols.airdrop(
                    this.#handle,
                    pubkeyBuf,
                    BigInt(pubkeyBuf.byteLength),
                    BigInt(lamportNum),
                ),
            ),
        );
    }

    getAccount(pubkey: Uint8Array): SerializableAccount | null {
        const pubkeyBuf = new Uint8Array(pubkey);
        const result = decodeResult<{
            value?: SerializableAccountJson | null;
            error?: string | null;
        }>(
            symbols.get_account(
                this.#handle,
                pubkeyBuf,
                BigInt(pubkeyBuf.byteLength),
            ),
        );
        if (result.error) throw new Error(result.error);
        return convertAccountFromJson(result.value);
    }

    setAccount(pubkey: Uint8Array, account: SerializableAccount): void {
        const jsonBytes = new TextEncoder().encode(
            JSON.stringify({
                lamports: account.lamports,
                data: Array.from(account.data),
                owner: Array.from(account.owner),
                executable: account.executable,
                rent_epoch: account.rent_epoch,
            }),
        );
        const encoded = new Uint8Array(4 + jsonBytes.length);
        new DataView(encoded.buffer).setUint32(0, jsonBytes.length, true);
        encoded.set(jsonBytes, 4);
        const ptr = Deno.UnsafePointer.of(encoded);
        if (!ptr) throw new Error("Failed to create pointer for account data");
        const pubkeyBuf = new Uint8Array(pubkey);
        unwrapVoid(
            decodeResult(
                symbols.set_account(
                    this.#handle,
                    pubkeyBuf,
                    BigInt(pubkeyBuf.byteLength),
                    ptr,
                ),
            ),
        );
    }

    addProgram(programId: Uint8Array, programBytes: Uint8Array): void {
        const id = new Uint8Array(programId);
        const elf = new Uint8Array(programBytes);
        unwrapVoid(
            decodeResult(
                symbols.add_program(
                    this.#handle,
                    id,
                    BigInt(id.byteLength),
                    elf,
                    BigInt(elf.byteLength),
                ),
            ),
        );
    }

    sendLegacyTransaction(bytes: Uint8Array): TransactionResultEnvelope {
        const tx = new Uint8Array(bytes);
        return flattenTxResult(
            unwrapValue(
                decodeResult<{
                    value?: TransactionResultEnvelope;
                    error?: string | null;
                }>(
                    symbols.send_legacy_transaction(
                        this.#handle,
                        tx,
                        BigInt(tx.byteLength),
                    ),
                ),
            ),
        );
    }

    sendVersionedTransaction(bytes: Uint8Array): TransactionResultEnvelope {
        const tx = new Uint8Array(bytes);
        return flattenTxResult(
            unwrapValue(
                decodeResult<{
                    value?: TransactionResultEnvelope;
                    error?: string | null;
                }>(
                    symbols.send_versioned_transaction(
                        this.#handle,
                        tx,
                        BigInt(tx.byteLength),
                    ),
                ),
            ),
        );
    }

    simulateLegacyTransaction(bytes: Uint8Array): SimulationResultEnvelope {
        const tx = new Uint8Array(bytes);
        return unwrapValue(
            decodeResult<
                { value?: SimulationResultEnvelope; error?: string | null }
            >(
                symbols.simulate_legacy_transaction(
                    this.#handle,
                    tx,
                    BigInt(tx.byteLength),
                ),
            ),
        );
    }

    simulateVersionedTransaction(bytes: Uint8Array): SimulationResultEnvelope {
        const tx = new Uint8Array(bytes);
        return unwrapValue(
            decodeResult<
                { value?: SimulationResultEnvelope; error?: string | null }
            >(
                symbols.simulate_versioned_transaction(
                    this.#handle,
                    tx,
                    BigInt(tx.byteLength),
                ),
            ),
        );
    }

    setTransactionHistory(capacity: number): void {
        unwrapVoid(
            decodeResult(
                symbols.set_transaction_history(this.#handle, BigInt(capacity)),
            ),
        );
    }

    minimumBalanceForRentExemption(dataLength: number): number {
        return Number(
            unwrapValue(
                decodeResult<{ value?: number; error?: string | null }>(
                    symbols.minimum_balance_for_rent_exemption(
                        this.#handle,
                        BigInt(dataLength),
                    ),
                ),
            ),
        );
    }

    getClockInfo(): ClockInfo {
        return unwrapValue(
            decodeResult<{ value?: ClockInfo; error?: string | null }>(
                symbols.get_sysvar_clock(this.#handle),
            ),
        );
    }

    setClockInfo(clock: ClockInfo): void {
        unwrapVoid(
            decodeResult(
                symbols.set_sysvar_clock(
                    this.#handle,
                    BigInt(clock.slot),
                    BigInt(clock.epoch),
                    BigInt(clock.unix_timestamp),
                    BigInt(clock.leader_schedule_epoch),
                    BigInt(clock.epoch_start_timestamp),
                ),
            ),
        );
    }

    warpToSlot(slot: number): void {
        unwrapVoid(
            decodeResult(symbols.warp_to_slot(this.#handle, BigInt(slot))),
        );
    }

    getTransactionBySignature(
        signature: Uint8Array,
    ): TransactionResultEnvelope | null {
        if (signature.length !== 64) {
            throw new Error("expected 64 byte signature");
        }
        const sigBuf = new Uint8Array(signature);
        const raw = unwrapOptionalValue(
            decodeResult<{
                value?: TransactionResultEnvelope | null;
                error?: string | null;
            }>(
                symbols.get_transaction_by_sig(
                    this.#handle,
                    sigBuf,
                    BigInt(sigBuf.byteLength),
                ),
            ),
        );
        return raw ? flattenTxResult(raw) : null;
    }
}
