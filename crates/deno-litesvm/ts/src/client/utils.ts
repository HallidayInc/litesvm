import type { SerializableAccount } from "../litesvm.ts";
import {
    decodeBase64,
    PublicKey,
    TOKEN_2022_PROGRAM_PUBKEY,
    TOKEN_ACCOUNT_SIZE,
    Transaction,
    VersionedTransaction,
} from "../solana.ts";

export const PROGRAM_DATA_HEADER_SIZE = 45;
export const BUFFER_HEADER_SIZE = 37;

export function normalizeAccount(value: unknown): SerializableAccount | null {
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
    const rentEpoch =
        rawRentEpoch !== undefined && rawRentEpoch > Number.MAX_SAFE_INTEGER
            ? 0
            : (rawRentEpoch ?? 0);

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
            const bytes = encoding === "base64"
                ? decodeBase64(payload)
                : new Uint8Array();
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

export function isVersioned(
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

export function enforceTxWireSize(bytes: Uint8Array): void {
    if (bytes.length > MAX_TX_WIRE_SIZE) {
        throw new Error(
            `Transaction too large: ${bytes.length} bytes (max raw ${MAX_TX_WIRE_SIZE}, ` +
                `base64 ${
                    Math.ceil(bytes.length / 3) * 4
                }). A real RPC would reject this; ` +
                `litesvm enforces the same limit. Split the work into smaller transactions.`,
        );
    }
}

// Maps a token-2022 mint's extensions to the account-side extensions its token
// accounts must carry. ATAs always include ImmutableOwner; TransferFeeConfig,
// NonTransferable, and TransferHook mints mandate matching account extensions.
export function requiredAccountExtensions(
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

export function tokenProgramForMintAccount(
    mint_account: SerializableAccount | null | undefined,
): PublicKey | undefined {
    const mint_owner = mint_account
        ? new PublicKey(mint_account.owner).toBase58()
        : undefined;
    return mint_owner === TOKEN_2022_PROGRAM_PUBKEY
        ? new PublicKey(TOKEN_2022_PROGRAM_PUBKEY)
        : undefined;
}
