// Minimal Solana-like primitives for Deno without external deps
// Supports basic keypairs, message compilation, and transaction serialization

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// ── Base58 ────────────────────────────────────────────────────────────────────

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = BigInt(ALPHABET.length);
const ALPHABET_MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = i;

export function decodeBase58(value: string): Uint8Array {
    if (value.length === 0) return new Uint8Array();
    let zeros = 0;
    while (zeros < value.length && value[zeros] === "1") zeros++;
    let acc = 0n;
    for (const ch of value) {
        const digit = ALPHABET_MAP[ch];
        if (digit === undefined) throw new Error("invalid base58 character");
        acc = acc * BASE + BigInt(digit);
    }
    const bytes: number[] = [];
    while (acc > 0n) {
        bytes.push(Number(acc % 256n));
        acc /= 256n;
    }
    for (let i = 0; i < zeros; i++) bytes.push(0);
    return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(bytes: Uint8Array): string {
    if (bytes.length === 0) return "";
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    let value = 0n;
    for (const b of bytes) value = (value << 8n) + BigInt(b);
    let encoded = "";
    while (value > 0n) {
        encoded = ALPHABET[Number(value % BASE)] + encoded;
        value /= BASE;
    }
    for (let i = 0; i < zeros; i++) encoded = "1" + encoded;
    return encoded;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function shortvecEncode(length: number): number[] {
    const out: number[] = [];
    let rem = length;
    while (true) {
        let elem = rem & 0x7f;
        rem >>= 7;
        if (rem === 0) {
            out.push(elem);
            break;
        }
        elem |= 0x80;
        out.push(elem);
    }
    return out;
}
/**
 * Decode a compact-u16 (shortvec) value from a byte array.
 * Inverse of the internal shortvecEncode function.
 *
 * @returns [value, bytesConsumed]
 */
export function shortvecDecode(
    bytes: Uint8Array,
    offset: number,
): [number, number] {
    let value = 0;
    let shift = 0;
    let consumed = 0;
    while (true) {
        const byte = bytes[offset + consumed];
        consumed++;
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [value, consumed];
}

/** Size of the ALT account metadata header */
const ALT_METADATA_SIZE = 56;

/**
 * Parse an Address Lookup Table account's data to extract the stored addresses.
 * ALT layout: [56 bytes metadata][N × 32 bytes addresses]
 */
export function parseAltAccount(data: Uint8Array): PublicKey[] {
    const addresses: PublicKey[] = [];
    for (let i = ALT_METADATA_SIZE; i + 32 <= data.length; i += 32) {
        addresses.push(new PublicKey(data.slice(i, i + 32)));
    }
    return addresses;
}

export function toLittleEndian(value: bigint, bytes: number): Uint8Array {
    const out = new Uint8Array(bytes);
    let v = value;
    for (let i = 0; i < bytes; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

/**
 * Encode an unsigned `bigint` as a `bytes`-wide big-endian byte array.
 * Mirrors `toLittleEndian` for cases where the SVM expects BE bytes (e.g.
 * `decode_raw_u64` reads tx-account indices as 8-byte BE, and intender
 * registers holding numeric values are uniformly BE per `from_be_bytes` in
 * `svm/src/opcodes.rs`). Throws if `value` doesn't fit in `bytes`.
 */
export function toBigEndian(value: bigint, bytes: number): Uint8Array {
    if (value < 0n) throw new Error("toBigEndian: negative values not supported");
    const out = new Uint8Array(bytes);
    let v = value;
    for (let i = bytes - 1; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    if (v !== 0n) throw new Error(`toBigEndian: value exceeds ${bytes} bytes`);
    return out;
}

// ── Ed25519 curve check ───────────────────────────────────────────────────────

/**
 * Returns true if the given 32-byte point lies on the Ed25519 curve.
 * Uses Deno's built-in Web Crypto API (crypto.subtle.importKey).
 * A valid Ed25519 public key (on-curve) can be imported without error;
 * an off-curve point causes importKey to throw a DOMException.
 */
// Ed25519 curve constants for point validation
const ED25519_P = 2n ** 255n - 19n;
const ED25519_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = ((base % mod) + mod) % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function isOnEd25519Curve(point: Uint8Array): boolean {
    if (point.length !== 32) return false;
    // Decode y from compressed point (little-endian, top bit is sign of x)
    const bytes = new Uint8Array(point);
    bytes[31] &= 0x7f; // clear sign bit
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
    if (y >= ED25519_P) return false;
    // Check if x² = (y² - 1) / (d·y² + 1) is a quadratic residue mod p
    const y2 = (y * y) % ED25519_P;
    const u = (y2 - 1n + ED25519_P) % ED25519_P;
    const v = (ED25519_D * y2 + 1n) % ED25519_P;
    const vInv = modPow(v, ED25519_P - 2n, ED25519_P);
    const x2 = (u * vInv) % ED25519_P;
    if (x2 === 0n) return true;
    // Euler's criterion: x² is a QR iff x²^((p-1)/2) ≡ 1 (mod p)
    return modPow(x2, (ED25519_P - 1n) / 2n, ED25519_P) === 1n;
}

// ── PublicKey ─────────────────────────────────────────────────────────────────

export class PublicKey {
    #bytes: Uint8Array;

    constructor(input: string | Uint8Array) {
        this.#bytes = typeof input === "string" ? decodeBase58(input) : new Uint8Array(input);
        if (this.#bytes.length !== 32) {
            throw new Error("PublicKey must be 32 bytes");
        }
    }

    static unique(): PublicKey {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        return new PublicKey(buf);
    }

    toBytes(): Uint8Array {
        return new Uint8Array(this.#bytes);
    }
    toBase58(): string {
        return encodeBase58(this.#bytes);
    }

    /** Byte-equal comparison. Accepts a `PublicKey`, a base58 string, or
     *  the raw 32-byte representation. */
    equals(other: PublicKey | string | Uint8Array): boolean {
        const other_bytes = other instanceof PublicKey
            ? other.toBytes()
            : typeof other === "string"
            ? decodeBase58(other)
            : other;
        if (other_bytes.length !== this.#bytes.length) return false;
        for (let i = 0; i < this.#bytes.length; i++) {
            if (this.#bytes[i] !== other_bytes[i]) return false;
        }
        return true;
    }
}

/**
 * Account metadata as it appears in a Solana instruction's `keys` array
 * (and in any "remaining accounts" list a CPI dispatcher forwards into a
 * top-level ix). Mirrors `solana_program::instruction::AccountMeta` plus
 * a permissive `is_signer` default. `pubkey` is a base58-encoded 32-byte
 * address.
 */
export interface SolAccountMeta {
    /**
     * Account pubkey. Accepted as either a base58 string (the natural
     * shape for hops emitting `SolutionPart.remaining_accounts` in TS)
     * or a `PublicKey` (used internally by message compilation). Sites
     * that need a real `PublicKey` should normalize via `new PublicKey(p)`.
     */
    pubkey: PublicKey | string;
    is_writable: boolean;
    is_signer?: boolean;
}

// ── SolanaSigner / Keypair ────────────────────────────────────────────────────

export interface SolanaSigner {
    sign(message: Uint8Array): Promise<Uint8Array>;
    getPublicKey(): PublicKey;
}

export class Keypair implements SolanaSigner {
    readonly publicKey: PublicKey;
    readonly secretKey: Uint8Array;
    #privateKey: CryptoKey;

    private constructor(
        publicKey: PublicKey,
        secretKey: Uint8Array,
        priv: CryptoKey,
    ) {
        this.publicKey = publicKey;
        this.secretKey = secretKey;
        this.#privateKey = priv;
    }

    static async generate(): Promise<Keypair> {
        const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
            "sign",
            "verify",
        ]) as CryptoKeyPair;
        const rawPub = new Uint8Array(
            await crypto.subtle.exportKey("raw", kp.publicKey),
        );
        const rawPriv = new Uint8Array(
            await crypto.subtle.exportKey("pkcs8", kp.privateKey),
        );
        return new Keypair(new PublicKey(rawPub), rawPriv, kp.privateKey);
    }

    /**
     * Create a Keypair from a raw 32-byte seed or 64-byte secret key
     * (first 32 bytes = Ed25519 seed, last 32 bytes = public key — Solana SDK convention).
     */
    static async fromSecretKey(secretKey: Uint8Array): Promise<Keypair> {
        const seed = secretKey.length === 64 ? secretKey.slice(0, 32) : secretKey;
        if (seed.length !== 32) {
            throw new Error(
                "Secret key must be 32 bytes (seed) or 64 bytes (seed + pubkey)",
            );
        }

        // PKCS8 wrapper for Ed25519: fixed 16-byte header + 32-byte seed
        const pkcs8 = new Uint8Array(48);
        pkcs8.set([
            0x30,
            0x2e,
            0x02,
            0x01,
            0x00,
            0x30,
            0x05,
            0x06,
            0x03,
            0x2b,
            0x65,
            0x70,
            0x04,
            0x22,
            0x04,
            0x20,
        ]);
        pkcs8.set(seed, 16);

        const privateKey = await crypto.subtle.importKey(
            "pkcs8",
            pkcs8,
            { name: "Ed25519" },
            true,
            ["sign"],
        );

        // Extract the public key from the JWK representation (field "x" = base64url public key)
        const jwk = await crypto.subtle.exportKey("jwk", privateKey);
        const rawPub = Uint8Array.from(
            atob(jwk.x!.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
        );
        const exportedPkcs8 = new Uint8Array(
            await crypto.subtle.exportKey("pkcs8", privateKey),
        );

        return new Keypair(new PublicKey(rawPub), exportedPkcs8, privateKey);
    }

    getPublicKey(): PublicKey {
        return this.publicKey;
    }

    async sign(message: Uint8Array): Promise<Uint8Array> {
        return new Uint8Array(
            await crypto.subtle.sign(
                { name: "Ed25519" },
                this.#privateKey,
                new Uint8Array(message),
            ),
        );
    }
}

// ── Message compilation ───────────────────────────────────────────────────────

export interface Instruction {
    programId: PublicKey;
    keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
    data: Uint8Array;
}

/**
 * Builder-side instruction shape (what callers pass to `Transaction.add`).
 * Kept as a separate name from `Instruction` so consumers (`chain.ts`,
 * `Sol.SPWFactory.*`) don't have to update — `Transaction.instructions`
 * now returns `Instruction[]` directly with `programId` resolved to a
 * `PublicKey` and `keys` as `SolAccountMeta[]`.
 */
export type InstructionInput = Instruction;

export interface CompiledMessage {
    accountKeys: PublicKey[];
    header: {
        requiredSignatures: number;
        readonlySigned: number;
        readonlyUnsigned: number;
    };
    recentBlockhash: string;
    instructions: {
        programIdIndex: number;
        accounts: number[];
        data: Uint8Array;
    }[];
}

/**
 * ALT-aware compile: any non-signer pubkey that appears in a provided ALT
 * (and matches the writable/readonly bucket) moves to that ALT's lookup
 * indices instead of taking a slot in the static account keys. Net effect:
 * the serialized outer-tx bytes shrink dramatically when many accounts are
 * carried by ALTs (e.g. multi-hop Jupiter swap tx that comes with full pool
 * + tick-array sets pre-packed into Jupiter's ALT).
 *
 * The returned `ixToCombinedIndex` lets callers translate each inner-ix
 * meta's pubkey into the runtime's combined (static + ALT-resolved) index.
 * Inner-ix `accounts` arrays must use these indices; runtime exposes the
 * accounts to the program in inner-ix order, so the index assignments only
 * affect outer-tx encoding, not program-side `tx_accounts[idx]` semantics.
 */
function compileV0WithAlts(message: {
    payerKey: PublicKey;
    recentBlockhash: string;
    instructions: Instruction[];
    altLookupsResolved: { accountKey: PublicKey; addresses: PublicKey[] }[];
}): { compiled: CompiledMessage; altLookups: MessageV0AltLookup[] } {
    // Walk all ix metas; OR-merge writable/signer flags per pubkey.
    const metas = new Map<string, SolAccountMeta>();
    const addMeta = (meta: SolAccountMeta) => {
        const key = typeof meta.pubkey === "string" ? meta.pubkey : meta.pubkey.toBase58();
        const existing = metas.get(key);
        if (!existing) metas.set(key, { ...meta });
        else {
            existing.is_signer = existing.is_signer || meta.is_signer;
            existing.is_writable = existing.is_writable || meta.is_writable;
        }
    };
    addMeta({ pubkey: message.payerKey, is_signer: true, is_writable: true });
    for (const ix of message.instructions) {
        addMeta({ pubkey: ix.programId, is_signer: false, is_writable: false });
        for (const key of ix.keys) {
            addMeta({
                pubkey: key.pubkey,
                is_signer: key.isSigner,
                is_writable: key.isWritable,
            });
        }
    }

    // Index each ALT's addresses for fast lookup. Bucket every pubkey:
    // signers + programs always stay static (Solana requires it for signers,
    // and program-id resolution can't see through ALTs at the message level).
    const altIndexByPubkey = new Map<
        string,
        { altIdx: number; addrIdx: number }
    >();
    message.altLookupsResolved.forEach((alt, altIdx) => {
        alt.addresses.forEach((addr, addrIdx) => {
            const key = addr.toBase58();
            if (!altIndexByPubkey.has(key)) {
                altIndexByPubkey.set(key, { altIdx, addrIdx });
            }
        });
    });
    const programIds = new Set<string>(
        message.instructions.map((ix) => typeof ix.programId === "string" ? ix.programId : ix.programId.toBase58()),
    );

    const staticMetas: SolAccountMeta[] = [];
    const altWritables = message.altLookupsResolved.map(() => [] as { addrIdx: number; pubkey: string }[]);
    const altReadonlies = message.altLookupsResolved.map(() => [] as { addrIdx: number; pubkey: string }[]);
    for (const meta of metas.values()) {
        const key = typeof meta.pubkey === "string" ? meta.pubkey : meta.pubkey.toBase58();
        const altHit = !meta.is_signer && !programIds.has(key) ? altIndexByPubkey.get(key) : undefined;
        if (!altHit) {
            staticMetas.push(meta);
            continue;
        }
        const bucket = meta.is_writable ? altWritables[altHit.altIdx] : altReadonlies[altHit.altIdx];
        bucket.push({ addrIdx: altHit.addrIdx, pubkey: key });
    }

    // Static keys in Solana's canonical header order.
    const signers = staticMetas.filter((m) => m.is_signer);
    const nonSigners = staticMetas.filter((m) => !m.is_signer);
    const orderedStatic = [
        ...signers.filter((m) => m.is_writable),
        ...signers.filter((m) => !m.is_writable),
        ...nonSigners.filter((m) => m.is_writable),
        ...nonSigners.filter((m) => !m.is_writable),
    ];

    // Combined-index space: static, then ALT writables (per-ALT in order), then ALT readonlies.
    const toB58 = (p: PublicKey | string) => typeof p === "string" ? p : p.toBase58();
    const indexFor = new Map<string, number>();
    orderedStatic.forEach((m, i) => indexFor.set(toB58(m.pubkey), i));
    let cursor = orderedStatic.length;
    for (const bucket of altWritables) {
        for (const { pubkey } of bucket) indexFor.set(pubkey, cursor++);
    }
    for (const bucket of altReadonlies) {
        for (const { pubkey } of bucket) indexFor.set(pubkey, cursor++);
    }

    const altLookups: MessageV0AltLookup[] = message.altLookupsResolved
        .map((alt, altIdx) => ({
            accountKey: alt.accountKey,
            writableIndexes: altWritables[altIdx].map((e) => e.addrIdx),
            readonlyIndexes: altReadonlies[altIdx].map((e) => e.addrIdx),
        }))
        .filter((l) => l.writableIndexes.length > 0 || l.readonlyIndexes.length > 0);

    const compiled: CompiledMessage = {
        accountKeys: orderedStatic.map((m) => typeof m.pubkey === "string" ? new PublicKey(m.pubkey) : m.pubkey),
        header: {
            requiredSignatures: signers.length,
            readonlySigned: signers.filter((m) => !m.is_writable).length,
            readonlyUnsigned: nonSigners.filter((m) => !m.is_writable).length,
        },
        recentBlockhash: message.recentBlockhash,
        instructions: message.instructions.map((ix) => ({
            programIdIndex: indexFor.get(toB58(ix.programId))!,
            accounts: ix.keys.map((k) => indexFor.get(toB58(k.pubkey))!),
            data: ix.data,
        })),
    };

    return { compiled, altLookups };
}

function compile(message: {
    payerKey: PublicKey;
    recentBlockhash: string;
    instructions: Instruction[];
}): CompiledMessage {
    const metas = new Map<
        string,
        SolAccountMeta
    >();

    const addMeta = (
        meta: SolAccountMeta,
    ) => {
        // pubkey may arrive as PublicKey or base58 string — normalize.
        const key = typeof meta.pubkey === "string" ? meta.pubkey : meta.pubkey.toBase58();
        const existing = metas.get(key);
        if (!existing) metas.set(key, { ...meta });
        else {
            existing.is_signer = existing.is_signer || meta.is_signer;
            existing.is_writable = existing.is_writable || meta.is_writable;
        }
    };

    addMeta({ pubkey: message.payerKey, is_signer: true, is_writable: true });
    for (const ix of message.instructions) {
        addMeta({ pubkey: ix.programId, is_signer: false, is_writable: false });
        // `ix.keys` uses camelCase (`isSigner`/`isWritable`) to match
        // SolanaWeb3's `AccountMeta` shape; bridge it to the internal
        // snake-case `SolAccountMeta` used throughout `compile`.
        for (const key of ix.keys) {
            addMeta({
                pubkey: key.pubkey,
                is_signer: key.isSigner,
                is_writable: key.isWritable,
            });
        }
    }

    const metasArr = Array.from(metas.values());
    const signers = metasArr.filter((m) => m.is_signer);
    const nonSigners = metasArr.filter((m) => !m.is_signer);
    const ordered = [
        ...signers.filter((m) => m.is_writable),
        ...signers.filter((m) => !m.is_writable),
        ...nonSigners.filter((m) => m.is_writable),
        ...nonSigners.filter((m) => !m.is_writable),
    ];

    const toB58 = (p: PublicKey | string) => typeof p === "string" ? p : p.toBase58();
    const indexFor = new Map<string, number>();
    ordered.forEach((meta, idx) => indexFor.set(toB58(meta.pubkey), idx));

    return {
        accountKeys: ordered.map((m) => typeof m.pubkey === "string" ? new PublicKey(m.pubkey) : m.pubkey),
        header: {
            requiredSignatures: signers.length,
            readonlySigned: signers.filter((m) => !m.is_writable).length,
            readonlyUnsigned: nonSigners.filter((m) => !m.is_writable).length,
        },
        recentBlockhash: message.recentBlockhash,
        instructions: message.instructions.map((ix) => ({
            programIdIndex: indexFor.get(toB58(ix.programId))!,
            accounts: ix.keys.map((k) => indexFor.get(toB58(k.pubkey))!),
            data: ix.data,
        })),
    };
}

/**
 * Serialize a full V0 message including ALT lookups. `MessageV0.serialize`
 * uses `serializeMessage` + an `0x80` prefix + a trailing `0` (zero ALT
 * lookups), which is fine for messages we built ourselves (we don't
 * compile ALT-using messages). Round-tripping a `VersionedTransaction`
 * parsed from bytes that DOES use ALTs needs to emit those lookup
 * sections too, so callers that mutate parse-path state (e.g.
 * `setBlockhash`) reach for this instead.
 */
function serializeV0MessageWithAlts(args: {
    header: CompiledMessage["header"];
    staticAccountKeys: Uint8Array[];
    blockhash: string;
    instructions: CompiledMessage["instructions"];
    altLookups: {
        accountKey: Uint8Array;
        writableIndexes: number[];
        readonlyIndexes: number[];
    }[];
}): Uint8Array {
    const parts: number[] = [];
    parts.push(0x80); // V0 version flag
    parts.push(
        args.header.requiredSignatures & 0xff,
        args.header.readonlySigned & 0xff,
        args.header.readonlyUnsigned & 0xff,
    );
    parts.push(...shortvecEncode(args.staticAccountKeys.length));
    for (const key of args.staticAccountKeys) parts.push(...key);
    const blockhashBytes = decodeBase58(args.blockhash);
    if (blockhashBytes.length !== 32) {
        throw new Error("invalid blockhash length");
    }
    parts.push(...blockhashBytes);
    parts.push(...shortvecEncode(args.instructions.length));
    for (const ix of args.instructions) {
        parts.push(ix.programIdIndex);
        parts.push(...shortvecEncode(ix.accounts.length));
        parts.push(...ix.accounts);
        parts.push(...shortvecEncode(ix.data.length));
        parts.push(...ix.data);
    }
    parts.push(...shortvecEncode(args.altLookups.length));
    for (const lookup of args.altLookups) {
        parts.push(...lookup.accountKey);
        parts.push(...shortvecEncode(lookup.writableIndexes.length));
        parts.push(...lookup.writableIndexes);
        parts.push(...shortvecEncode(lookup.readonlyIndexes.length));
        parts.push(...lookup.readonlyIndexes);
    }
    return Uint8Array.from(parts);
}

function serializeMessage(compiled: CompiledMessage): Uint8Array {
    const parts: number[] = [];
    const { header, accountKeys, recentBlockhash, instructions } = compiled;
    parts.push(
        header.requiredSignatures & 0xff,
        header.readonlySigned & 0xff,
        header.readonlyUnsigned & 0xff,
    );
    parts.push(...shortvecEncode(accountKeys.length));
    for (const key of accountKeys) {
        parts.push(...key.toBytes());
    }

    const blockhashBytes = decodeBase58(recentBlockhash);
    if (blockhashBytes.length !== 32) {
        throw new Error("invalid blockhash length");
    }
    parts.push(...blockhashBytes);

    parts.push(...shortvecEncode(instructions.length));
    for (const ix of instructions) {
        parts.push(ix.programIdIndex);
        parts.push(...shortvecEncode(ix.accounts.length));
        parts.push(...ix.accounts);
        parts.push(...shortvecEncode(ix.data.length));
        parts.push(...ix.data);
    }
    return Uint8Array.from(parts);
}

// ── Transaction ───────────────────────────────────────────────────────────────

/**
 * Legacy Solana transaction. Always lives in a single "live" state:
 * `feePayer` + `recentBlockhash` + `#instructions` + `#signatures`.
 * `fromBytes` parses a wire-format tx and populates those fields
 * directly — no parallel "#parsed*" state is kept around. Anything
 * that reads compiled wire data (`staticAccountKeys`, `header`,
 * `serialize`, etc.) recompiles from `#instructions` on demand.
 *
 * Trade-off: round-tripping `fromBytes → serialize` may reorder
 * accounts when `compile()`'s deterministic ordering disagrees with
 * the original byte layout, which would invalidate the parsed
 * signatures. That's intentional — the only realistic use case for
 * round-tripping is "parse, mutate (e.g. swap blockhash), re-sign",
 * so we drop the old `#raw` byte-tracking complexity instead of
 * preserving byte-perfect identity that nothing relies on.
 */
export class Transaction {
    recentBlockhash: string;
    feePayer: PublicKey;
    #instructions: Instruction[] = [];
    #signatures: { publicKey: PublicKey; signature: Uint8Array }[] = [];

    constructor(feePayer: PublicKey, recentBlockhash: string) {
        this.recentBlockhash = recentBlockhash;
        this.feePayer = feePayer;
    }

    /**
     * Parse a serialized legacy transaction. Re-hydrates the compiled
     * `(programIdIndex, accounts, data)` wire form into structured
     * `Instruction` objects so subsequent reads/serializes go through
     * the same `compile()` path as a freshly built tx.
     */
    static fromBytes(bytes: Uint8Array): Transaction {
        let offset = 0;

        // Signatures (raw bytes; pubkeys resolved below from account keys)
        const [numSigs, sigConsumed] = shortvecDecode(bytes, offset);
        offset += sigConsumed;
        const rawSignatures: Uint8Array[] = [];
        for (let i = 0; i < numSigs; i++) {
            rawSignatures.push(bytes.slice(offset, offset + 64));
            offset += 64;
        }

        // Header
        const header = {
            requiredSignatures: bytes[offset++],
            readonlySigned: bytes[offset++],
            readonlyUnsigned: bytes[offset++],
        };

        // Account keys
        const [numKeys, keysConsumed] = shortvecDecode(bytes, offset);
        offset += keysConsumed;
        const accountKeys: PublicKey[] = [];
        for (let i = 0; i < numKeys; i++) {
            accountKeys.push(new PublicKey(bytes.slice(offset, offset + 32)));
            offset += 32;
        }

        // Blockhash
        const recentBlockhash = encodeBase58(bytes.slice(offset, offset + 32));
        offset += 32;

        // Instructions — rehydrate compiled form into Instruction[]
        const sigCount = header.requiredSignatures;
        const writableSigned = sigCount - header.readonlySigned;
        const total = accountKeys.length;
        const writableUnsigned = total - sigCount - header.readonlyUnsigned;
        const isSigner = (i: number) => i < sigCount;
        const isWritable = (i: number) =>
            (i < writableSigned) ||
            (i >= sigCount && i < sigCount + writableUnsigned);

        const [numIxs, ixConsumed] = shortvecDecode(bytes, offset);
        offset += ixConsumed;
        const instructions: Instruction[] = [];
        for (let i = 0; i < numIxs; i++) {
            const programIdIndex = bytes[offset++];
            const [numAccounts, accConsumed] = shortvecDecode(bytes, offset);
            offset += accConsumed;
            const accountIdxs: number[] = [];
            for (let j = 0; j < numAccounts; j++) accountIdxs.push(bytes[offset++]);
            const [dataLen, dataConsumed] = shortvecDecode(bytes, offset);
            offset += dataConsumed;
            const data = bytes.slice(offset, offset + dataLen);
            offset += dataLen;
            instructions.push({
                programId: accountKeys[programIdIndex],
                keys: accountIdxs.map((idx) => ({
                    pubkey: accountKeys[idx],
                    isSigner: isSigner(idx),
                    isWritable: isWritable(idx),
                })),
                data,
            });
        }

        const feePayer = accountKeys.length > 0 ? accountKeys[0] : new PublicKey(new Uint8Array(32));
        const tx = new Transaction(feePayer, recentBlockhash);
        tx.#instructions = instructions;
        tx.#signatures = rawSignatures.map((signature, i) => ({
            publicKey: accountKeys[i] ?? new PublicKey(new Uint8Array(32)),
            signature,
        }));
        return tx;
    }

    add(...ix: Instruction[]): this {
        this.#instructions.push(...ix);
        return this;
    }

    /** Recompile the tx from current fields. Cached implicitly by callers. */
    #compile(): CompiledMessage {
        return compile({
            payerKey: this.feePayer,
            recentBlockhash: this.recentBlockhash,
            instructions: this.#instructions,
        });
    }

    async sign(...signers: SolanaSigner[]) {
        const compiled = this.#compile();
        const message = serializeMessage(compiled);
        const signerByKey = new Map(
            signers.map((s) => [s.getPublicKey().toBase58(), s]),
        );
        const slots = compiled.accountKeys.slice(
            0,
            compiled.header.requiredSignatures,
        );
        this.#signatures = await Promise.all(slots.map(async (pk) => {
            const signer = signerByKey.get(pk.toBase58());
            if (!signer) throw new Error(`missing signer for ${pk.toBase58()}`);
            return { publicKey: pk, signature: await signer.sign(message) };
        }));
    }

    /** Ordered account keys (signers first, then non-signers). */
    get staticAccountKeys(): PublicKey[] {
        return this.#compile().accountKeys;
    }

    /** Resolved `Instruction[]` — exactly what was added or parsed in. */
    get instructions(): Instruction[] {
        return this.#instructions;
    }

    /** Message header (signature counts). */
    get header(): CompiledMessage["header"] {
        return this.#compile().header;
    }

    /** Base58-encoded signatures. */
    get signatures(): string[] {
        return this.#signatures.map((s) => encodeBase58(s.signature));
    }

    serialize(): Uint8Array {
        if (this.#signatures.length === 0) {
            throw new Error("transaction not signed");
        }
        const message = serializeMessage(this.#compile());
        const parts: number[] = [];
        parts.push(...shortvecEncode(this.#signatures.length));
        for (const sig of this.#signatures) parts.push(...sig.signature);
        parts.push(...message);
        return Uint8Array.from(parts);
    }

    serializeBase64(): string {
        const bytes = this.serialize();
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }
}

// ── VersionedTransaction ──────────────────────────────────────────────────────

/** Address-lookup-table reference embedded in a V0 message. */
export interface MessageV0AltLookup {
    accountKey: PublicKey;
    writableIndexes: number[];
    readonlyIndexes: number[];
}

export class MessageV0 {
    #compiled: CompiledMessage;
    #altLookups: MessageV0AltLookup[];

    constructor(
        compiled: CompiledMessage,
        altLookups: MessageV0AltLookup[] = [],
    ) {
        this.#compiled = compiled;
        this.#altLookups = altLookups;
    }

    /**
     * Build a `MessageV0` from a fee payer + blockhash + list of
     * structured `Instruction`s. Runs the same `compile()` step as the
     * legacy `Transaction` builder to derive account ordering and the
     * header. Use this instead of constructing a `MessageV0` directly
     * when you only have the inputs the user typed (payer, blockhash,
     * ixs) rather than an already-compiled message.
     */
    static fromInstructions(args: {
        payerKey: PublicKey;
        recentBlockhash: string;
        instructions: Instruction[];
        altLookups?: MessageV0AltLookup[];
    }): MessageV0 {
        return new MessageV0(
            compile({
                payerKey: args.payerKey,
                recentBlockhash: args.recentBlockhash,
                instructions: args.instructions,
            }),
            args.altLookups,
        );
    }

    // Build a V0 message that compacts ALT-resolved pubkeys out of static keys.
    // `altLookupsResolved` carries each ALT's full address list (typically loaded
    // via `LocalClient.loadAccounts(...)` + `parseAltAccount`). The compiler
    // emits ALT lookups only for ALTs that actually carry referenced accounts.
    static fromInstructionsWithAlts(args: {
        payerKey: PublicKey;
        recentBlockhash: string;
        instructions: Instruction[];
        altLookupsResolved: { accountKey: PublicKey; addresses: PublicKey[] }[];
    }): MessageV0 {
        const { compiled, altLookups } = compileV0WithAlts({
            payerKey: args.payerKey,
            recentBlockhash: args.recentBlockhash,
            instructions: args.instructions,
            altLookupsResolved: args.altLookupsResolved,
        });
        return new MessageV0(compiled, altLookups);
    }

    /** Compiled wire form: programIdIndex + account-index list + data. */
    get compiledInstructions(): CompiledMessage["instructions"] {
        return this.#compiled.instructions;
    }

    get header(): CompiledMessage["header"] {
        return this.#compiled.header;
    }

    get staticAccountKeys(): PublicKey[] {
        return this.#compiled.accountKeys;
    }

    get recentBlockhash(): string {
        return this.#compiled.recentBlockhash;
    }

    get addressTableLookups(): readonly MessageV0AltLookup[] {
        return this.#altLookups;
    }

    /**
     * Build a sibling `MessageV0` that's identical to this one except
     * for `recentBlockhash`. Used by `VersionedTransaction.setBlockhash`
     * to swap the blockhash without disturbing account ordering, header,
     * instructions, or ALT lookups.
     */
    withBlockhash(recentBlockhash: string): MessageV0 {
        return new MessageV0(
            { ...this.#compiled, recentBlockhash },
            this.#altLookups,
        );
    }

    serialize(): Uint8Array {
        return serializeV0MessageWithAlts({
            header: this.#compiled.header,
            staticAccountKeys: this.#compiled.accountKeys.map((k) => k.toBytes()),
            blockhash: this.#compiled.recentBlockhash,
            instructions: this.#compiled.instructions,
            altLookups: this.#altLookups.map((l) => ({
                accountKey: l.accountKey.toBytes(),
                writableIndexes: l.writableIndexes,
                readonlyIndexes: l.readonlyIndexes,
            })),
        });
    }
}

/**
 * Versioned (V0) Solana transaction. Wraps a single `MessageV0` (which
 * carries account ordering, header, instructions, blockhash, and any
 * ALT lookups) plus a list of signatures. `fromBytes` parses a wire-
 * format V0 tx and constructs a live `MessageV0` from the parsed
 * parts — no parallel "#parsed*" / "#raw" state hangs around. Every
 * getter / `serialize` goes through `#message.serialize()`.
 */
export class VersionedTransaction {
    readonly version = 0;
    #message: MessageV0;
    #signatures: { publicKey: PublicKey; signature: Uint8Array }[] = [];

    constructor(message: MessageV0) {
        this.#message = message;
    }

    get message(): MessageV0 {
        return this.#message;
    }

    /**
     * Parse a raw V0 wire-format transaction. Re-hydrates header,
     * static account keys, instructions (compiled form), blockhash,
     * and ALT lookups into a fresh `MessageV0`, then attaches the
     * original signatures (resolved against the static keys for their
     * pubkeys).
     */
    static fromBytes(bytes: Uint8Array): VersionedTransaction {
        let offset = 0;

        // Signatures (raw bytes; pubkeys filled in below).
        const [numSigs, sigCountSize] = shortvecDecode(bytes, offset);
        offset += sigCountSize;
        const rawSignatures: Uint8Array[] = [];
        for (let i = 0; i < numSigs; i++) {
            rawSignatures.push(bytes.slice(offset, offset + 64));
            offset += 64;
        }

        // Version prefix. See `serializeV0MessageWithAlts` for the layout;
        // the high bit distinguishes versioned from legacy, the low 7
        // bits encode the version number.
        const versionPrefix = bytes[offset];
        if ((versionPrefix & 0x80) === 0) {
            throw new Error(
                `Expected V0 transaction (prefix 0x80), got 0x${versionPrefix.toString(16)}`,
            );
        }
        if ((versionPrefix & 0x7f) !== 0) {
            throw new Error(
                `Unsupported transaction version: ${versionPrefix & 0x7f}`,
            );
        }
        offset++;

        const header = {
            requiredSignatures: bytes[offset],
            readonlySigned: bytes[offset + 1],
            readonlyUnsigned: bytes[offset + 2],
        };
        offset += 3;

        const [numStaticKeys, staticKeysSize] = shortvecDecode(bytes, offset);
        offset += staticKeysSize;
        const staticKeys: PublicKey[] = [];
        for (let i = 0; i < numStaticKeys; i++) {
            staticKeys.push(new PublicKey(bytes.slice(offset, offset + 32)));
            offset += 32;
        }

        const recentBlockhash = encodeBase58(bytes.slice(offset, offset + 32));
        offset += 32;

        const [numInstructions, instrCountSize] = shortvecDecode(bytes, offset);
        offset += instrCountSize;
        const instructions: CompiledMessage["instructions"] = [];
        for (let i = 0; i < numInstructions; i++) {
            const programIdIndex = bytes[offset++];
            const [numAccounts, accCountSize] = shortvecDecode(bytes, offset);
            offset += accCountSize;
            const accounts: number[] = [];
            for (let j = 0; j < numAccounts; j++) {
                accounts.push(bytes[offset++]);
            }
            const [dataLength, dataLenSize] = shortvecDecode(bytes, offset);
            offset += dataLenSize;
            const data = bytes.slice(offset, offset + dataLength);
            offset += dataLength;
            instructions.push({ programIdIndex, accounts, data });
        }

        const [numAltLookups, altCountSize] = shortvecDecode(bytes, offset);
        offset += altCountSize;
        const altLookups: MessageV0AltLookup[] = [];
        for (let i = 0; i < numAltLookups; i++) {
            const accountKey = new PublicKey(bytes.slice(offset, offset + 32));
            offset += 32;
            const [numWritable, wSize] = shortvecDecode(bytes, offset);
            offset += wSize;
            const writableIndexes: number[] = [];
            for (let j = 0; j < numWritable; j++) {
                writableIndexes.push(bytes[offset++]);
            }
            const [numReadonly, rSize] = shortvecDecode(bytes, offset);
            offset += rSize;
            const readonlyIndexes: number[] = [];
            for (let j = 0; j < numReadonly; j++) {
                readonlyIndexes.push(bytes[offset++]);
            }
            altLookups.push({ accountKey, writableIndexes, readonlyIndexes });
        }

        const message = new MessageV0(
            {
                header,
                accountKeys: staticKeys,
                recentBlockhash,
                instructions,
            },
            altLookups,
        );
        const tx = new VersionedTransaction(message);
        tx.#signatures = rawSignatures.map((signature, i) => ({
            publicKey: staticKeys[i] ?? new PublicKey(new Uint8Array(32)),
            signature,
        }));
        return tx;
    }

    get staticAccountKeys(): PublicKey[] {
        return this.#message.staticAccountKeys;
    }

    get addressTableLookups(): readonly MessageV0AltLookup[] {
        return this.#message.addressTableLookups;
    }

    /**
     * Resolved `Instruction[]`: `programId` as `PublicKey`, `keys` with
     * `isSigner` / `isWritable` derived from the message header's
     * signer/writable partitioning of `staticAccountKeys`.
     *
     * Address-table-lookup entries are NOT folded into `keys` — those
     * resolve only at runtime inside the validator, so a static
     * deserializer can't include them without external state.
     */
    get instructions(): Instruction[] {
        const accountKeys = this.#message.staticAccountKeys;
        const header = this.#message.header;
        const sigCount = header.requiredSignatures;
        const writableSigned = sigCount - header.readonlySigned;
        const total = accountKeys.length;
        const writableUnsigned = total - sigCount - header.readonlyUnsigned;
        const isSigner = (i: number) => i < sigCount;
        const isWritable = (i: number) =>
            (i < writableSigned) ||
            (i >= sigCount && i < sigCount + writableUnsigned);
        return this.#message.compiledInstructions.map((ix) => ({
            programId: accountKeys[ix.programIdIndex],
            keys: ix.accounts.map((idx) => ({
                pubkey: accountKeys[idx],
                isSigner: isSigner(idx),
                isWritable: isWritable(idx),
            })),
            data: ix.data,
        }));
    }

    /** Base58-encoded signatures. */
    get signatures(): string[] {
        return this.#signatures.map((s) => encodeBase58(s.signature));
    }

    /**
     * Given resolved ALT data (base58 key → PublicKey[]), return all
     * account keys this transaction touches: static keys + ALT-derived
     * writable + readonly.
     */
    resolveAllAccounts(resolvedAlts: Map<string, PublicKey[]>): PublicKey[] {
        const accounts = [...this.staticAccountKeys];
        const writableEntries: PublicKey[] = [];
        const readonlyEntries: PublicKey[] = [];
        for (const lookup of this.addressTableLookups) {
            const altKey = lookup.accountKey.toBase58();
            const altAddresses = resolvedAlts.get(altKey);
            if (!altAddresses) throw new Error(`ALT ${altKey} not resolved`);
            for (const idx of lookup.writableIndexes) {
                if (idx >= altAddresses.length) {
                    throw new Error(`ALT ${altKey}: writable index ${idx} out of range`);
                }
                writableEntries.push(altAddresses[idx]);
            }
            for (const idx of lookup.readonlyIndexes) {
                if (idx >= altAddresses.length) {
                    throw new Error(`ALT ${altKey}: readonly index ${idx} out of range`);
                }
                readonlyEntries.push(altAddresses[idx]);
            }
        }
        accounts.push(...writableEntries, ...readonlyEntries);
        return accounts;
    }

    /**
     * Swap in a new blockhash. The underlying `MessageV0` is replaced
     * with one that's identical save for `recentBlockhash`, and prior
     * signatures are dropped (they no longer cover the new message
     * bytes). Accept the blockhash as a base58 string for symmetry
     * with `Transaction.recentBlockhash`; call sites holding a
     * `Uint8Array` should `encodeBase58(bytes)` first.
     */
    setBlockhash(recentBlockhash: string): void {
        this.#message = this.#message.withBlockhash(recentBlockhash);
        this.#signatures = [];
    }

    async sign(signers: SolanaSigner[]): Promise<void> {
        const messageBytes = this.#message.serialize();
        const signerByKey = new Map(
            signers.map((s) => [s.getPublicKey().toBase58(), s]),
        );
        const slots = this.#message.staticAccountKeys.slice(
            0,
            this.#message.header.requiredSignatures,
        );
        this.#signatures = await Promise.all(slots.map(async (pk) => {
            const signer = signerByKey.get(pk.toBase58());
            if (!signer) throw new Error(`missing signer for ${pk.toBase58()}`);
            return { publicKey: pk, signature: await signer.sign(messageBytes) };
        }));
    }

    serialize(): Uint8Array {
        if (this.#signatures.length === 0) {
            throw new Error("transaction not signed");
        }
        const messageBytes = this.#message.serialize();
        const parts: number[] = [];
        parts.push(...shortvecEncode(this.#signatures.length));
        for (const sig of this.#signatures) parts.push(...sig.signature);
        parts.push(...messageBytes);
        return Uint8Array.from(parts);
    }

    serializeBase64(): string {
        const bytes = this.serialize();
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const LAMPORTS_PER_SOL = 1_000_000_000;

// ── SystemProgram ─────────────────────────────────────────────────────────────

/**
 * Parsed SystemProgram instruction. Variant tag is a `u32 LE` at offset 0
 * of the instruction `data` blob; see solana-program/system_instruction.rs.
 * Only the variants used in production tx flows are decoded — anything
 * else surfaces as `Unknown` with the raw tag preserved for diagnostics.
 */
export type SystemInstruction =
    | { kind: "CreateAccount"; lamports: bigint; space: bigint; owner: PublicKey }
    | { kind: "Assign"; owner: PublicKey }
    | { kind: "Transfer"; lamports: bigint }
    | {
        kind: "CreateAccountWithSeed";
        base: PublicKey;
        seed: string;
        lamports: bigint;
        space: bigint;
        owner: PublicKey;
    }
    | { kind: "Allocate"; space: bigint }
    | { kind: "Unknown"; tag: number };

function readU32LE(d: Uint8Array, o: number): number {
    return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
}
function readU64LE(d: Uint8Array, o: number): bigint {
    return new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);
}

export class SystemProgram {
    static programId = new PublicKey(SYSTEM_PROGRAM_ID);

    /**
     * Decode a SystemProgram instruction `data` blob into a discriminated
     * union. Returns `{ kind: "Unknown", tag }` for tags we don't model
     * or for short/truncated buffers — callers can branch on `kind`
     * without try/catch.
     */
    static decodeInstruction(data: Uint8Array): SystemInstruction {
        if (data.length < 4) return { kind: "Unknown", tag: -1 };
        const tag = readU32LE(data, 0);
        switch (tag) {
            case 0: {
                // CreateAccount: [tag:u32le][lamports:u64le][space:u64le][owner:32]
                if (data.length < 4 + 8 + 8 + 32) return { kind: "Unknown", tag };
                return {
                    kind: "CreateAccount",
                    lamports: readU64LE(data, 4),
                    space: readU64LE(data, 12),
                    owner: new PublicKey(data.slice(20, 52)),
                };
            }
            case 1: {
                // Assign: [tag:u32le][owner:32]
                if (data.length < 4 + 32) return { kind: "Unknown", tag };
                return { kind: "Assign", owner: new PublicKey(data.slice(4, 36)) };
            }
            case 2: {
                // Transfer: [tag:u32le][lamports:u64le]
                if (data.length < 4 + 8) return { kind: "Unknown", tag };
                return { kind: "Transfer", lamports: readU64LE(data, 4) };
            }
            case 3: {
                // CreateAccountWithSeed:
                //   [tag:u32le][base:32][seed_len:u64le][seed:*]
                //   [lamports:u64le][space:u64le][owner:32]
                if (data.length < 4 + 32 + 8) return { kind: "Unknown", tag };
                const base = new PublicKey(data.slice(4, 36));
                const seed_len = Number(readU64LE(data, 36));
                const seed_off = 44;
                const lamports_off = seed_off + seed_len;
                if (data.length < lamports_off + 8 + 8 + 32) {
                    return { kind: "Unknown", tag };
                }
                const seed = new TextDecoder().decode(
                    data.slice(seed_off, seed_off + seed_len),
                );
                return {
                    kind: "CreateAccountWithSeed",
                    base,
                    seed,
                    lamports: readU64LE(data, lamports_off),
                    space: readU64LE(data, lamports_off + 8),
                    owner: new PublicKey(
                        data.slice(lamports_off + 16, lamports_off + 48),
                    ),
                };
            }
            case 8: {
                // Allocate: [tag:u32le][space:u64le]
                if (data.length < 4 + 8) return { kind: "Unknown", tag };
                return { kind: "Allocate", space: readU64LE(data, 4) };
            }
            default:
                return { kind: "Unknown", tag };
        }
    }

    static createAccount(
        fromPubkey: PublicKey,
        newAccountPubkey: PublicKey,
        lamports: number | bigint,
        space: number | bigint,
        programId: PublicKey,
    ): Instruction {
        const data = new Uint8Array(4 + 8 + 8 + 32);
        data.set(toLittleEndian(0n, 4), 0);
        data.set(toLittleEndian(BigInt(lamports), 8), 4);
        data.set(toLittleEndian(BigInt(space), 8), 12);
        data.set(programId.toBytes(), 20);
        return {
            programId: SystemProgram.programId,
            keys: [
                { pubkey: fromPubkey, isSigner: true, isWritable: true },
                { pubkey: newAccountPubkey, isSigner: true, isWritable: true },
            ],
            data,
        };
    }

    static transfer(
        fromPubkey: PublicKey,
        toPubkey: PublicKey,
        lamports: number | bigint,
    ): Instruction {
        const data = new Uint8Array(4 + 8);
        data.set(toLittleEndian(2n, 4), 0);
        data.set(toLittleEndian(BigInt(lamports), 8), 4);
        return {
            programId: SystemProgram.programId,
            keys: [
                { pubkey: fromPubkey, isSigner: true, isWritable: true },
                { pubkey: toPubkey, isSigner: false, isWritable: true },
            ],
            data,
        };
    }
}

// ── ComputeBudgetProgram ──────────────────────────────────────────────────────

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

export class ComputeBudgetProgram {
    static programId = new PublicKey(COMPUTE_BUDGET_PROGRAM_ID);

    /** Maximum compute units allowed per transaction on Solana. */
    static MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

    /** Set the compute unit limit for the transaction. */
    static setComputeUnitLimit(units: number): Instruction {
        const data = new Uint8Array(5);
        data[0] = 2; // SetComputeUnitLimit instruction index
        new DataView(data.buffer).setUint32(1, units, true);
        return {
            programId: ComputeBudgetProgram.programId,
            keys: [],
            data,
        };
    }

    /** Set the compute unit price (priority fee) in micro-lamports per compute unit. */
    static setComputeUnitPrice(micro_lamports: bigint): Instruction {
        const data = new Uint8Array(9);
        data[0] = 3; // SetComputeUnitPrice instruction index
        new DataView(data.buffer).setBigUint64(1, micro_lamports, true);
        return {
            programId: ComputeBudgetProgram.programId,
            keys: [],
            data,
        };
    }

    /** Request a specific heap frame size in bytes (must be multiple of 1024, max 256KB). */
    static requestHeapFrame(bytes: number): Instruction {
        const data = new Uint8Array(5);
        data[0] = 1; // RequestHeapFrame instruction index
        new DataView(data.buffer).setUint32(1, bytes, true);
        return {
            programId: ComputeBudgetProgram.programId,
            keys: [],
            data,
        };
    }
}

// ── PDA derivation ────────────────────────────────────────────────────────────

export interface ProgramAddress {
    address: PublicKey;
    bump: number;
}

async function createProgramAddress(
    seeds: Uint8Array[],
    programId: PublicKey,
): Promise<PublicKey> {
    const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
    let totalLength = 32 + PDA_MARKER.length;
    for (const seed of seeds) totalLength += seed.length;

    const buffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const seed of seeds) {
        buffer.set(seed, offset);
        offset += seed.length;
    }
    buffer.set(programId.toBytes(), offset);
    offset += 32;
    buffer.set(PDA_MARKER, offset);

    const hashBytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", buffer),
    );

    if (isOnEd25519Curve(hashBytes)) {
        throw new Error("Invalid seeds - address is on curve");
    }

    return new PublicKey(hashBytes);
}

export async function findProgramAddress(
    seeds: Uint8Array[],
    programId: PublicKey | string,
): Promise<ProgramAddress> {
    const id = typeof programId === "string" ? new PublicKey(programId) : programId;
    for (let bump = 255; bump >= 0; bump--) {
        try {
            const address = await createProgramAddress([
                ...seeds,
                new Uint8Array([bump]),
            ], id);
            return { address, bump };
        } catch {
            continue;
        }
    }
    throw new Error("Unable to find valid bump seed");
}

// ── SPL Token ─────────────────────────────────────────────────────────────────

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export async function getSPLAssociatedTokenAddress(
    mint: PublicKey,
    owner: PublicKey,
    programId: PublicKey = new PublicKey(TOKEN_PROGRAM_ID),
): Promise<PublicKey> {
    const { address } = await findProgramAddress(
        [owner.toBytes(), programId.toBytes(), mint.toBytes()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    );
    return address;
}

export class TokenProgram {
    static programId = new PublicKey(TOKEN_PROGRAM_ID);

    static initializeMint(opts: {
        mint: PublicKey;
        decimals: number;
        mintAuthority: PublicKey;
        freezeAuthority?: PublicKey | null;
    }): Instruction {
        const data = new Uint8Array(67);
        data[0] = 0; // InitializeMint
        data[1] = opts.decimals;
        data.set(opts.mintAuthority.toBytes(), 2);
        if (opts.freezeAuthority) {
            data[34] = 1;
            data.set(opts.freezeAuthority.toBytes(), 35);
        } else data[34] = 0;
        return {
            programId: TokenProgram.programId,
            keys: [
                { pubkey: opts.mint, isSigner: false, isWritable: true },
                {
                    pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"),
                    isSigner: false,
                    isWritable: false,
                },
            ],
            data,
        };
    }

    static initializeAccount(
        account: PublicKey,
        mint: PublicKey,
        owner: PublicKey,
    ): Instruction {
        return {
            programId: TokenProgram.programId,
            keys: [
                { pubkey: account, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: owner, isSigner: false, isWritable: false },
                {
                    pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"),
                    isSigner: false,
                    isWritable: false,
                },
            ],
            data: new Uint8Array([1]), // InitializeAccount
        };
    }

    static mintTo(
        mint: PublicKey,
        destination: PublicKey,
        authority: PublicKey,
        amount: bigint | number,
    ): Instruction {
        const data = new Uint8Array(9);
        data[0] = 7; // MintTo
        data.set(toLittleEndian(BigInt(amount), 8), 1);
        return {
            programId: TokenProgram.programId,
            keys: [
                { pubkey: mint, isSigner: false, isWritable: true },
                { pubkey: destination, isSigner: false, isWritable: true },
                { pubkey: authority, isSigner: true, isWritable: false },
            ],
            data,
        };
    }

    static transfer(
        source: PublicKey,
        destination: PublicKey,
        owner: PublicKey,
        amount: bigint | number,
        programId: PublicKey = TokenProgram.programId,
    ): Instruction {
        const data = new Uint8Array(9);
        data[0] = 3; // Transfer
        data.set(toLittleEndian(BigInt(amount), 8), 1);
        return {
            programId,
            keys: [
                { pubkey: source, isSigner: false, isWritable: true },
                { pubkey: destination, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: true, isWritable: false },
            ],
            data,
        };
    }

    // TransferChecked passes the mint + decimals so the program can validate
    // them. Token-2022 mints with extensions (e.g. a transfer fee, like PYUSD)
    // reject the plain Transfer and require this variant.
    static transferChecked(
        source: PublicKey,
        mint: PublicKey,
        destination: PublicKey,
        owner: PublicKey,
        amount: bigint | number,
        decimals: number,
        programId: PublicKey = TokenProgram.programId,
    ): Instruction {
        const data = new Uint8Array(10);
        data[0] = 12; // TransferChecked
        data.set(toLittleEndian(BigInt(amount), 8), 1);
        data[9] = decimals;
        return {
            programId,
            keys: [
                { pubkey: source, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: destination, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: true, isWritable: false },
            ],
            data,
        };
    }
}

export class AssociatedTokenProgram {
    static programId = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);

    static create(
        payer: PublicKey,
        associatedToken: PublicKey,
        owner: PublicKey,
        mint: PublicKey,
    ): Instruction {
        return {
            programId: AssociatedTokenProgram.programId,
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: associatedToken, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TokenProgram.programId, isSigner: false, isWritable: false },
            ],
            data: new Uint8Array(0),
        };
    }

    static createIdempotent(
        payer: PublicKey,
        associatedToken: PublicKey,
        owner: PublicKey,
        mint: PublicKey,
        tokenProgramId: PublicKey = TokenProgram.programId,
    ): Instruction {
        return {
            programId: AssociatedTokenProgram.programId,
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: associatedToken, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: tokenProgramId, isSigner: false, isWritable: false },
            ],
            data: new Uint8Array([1]), // CreateIdempotent
        };
    }
}

// ============================================================================
// BPF Loader Programs
// ============================================================================

const SYSVAR_RENT_ID = new PublicKey(
    "SysvarRent111111111111111111111111111111111",
);
const SYSVAR_CLOCK_ID = new PublicKey(
    "SysvarC1ock11111111111111111111111111111111",
);

/** Legacy BPF loader (v1). Still used by a handful of long-lived programs. */
export const BPF_LOADER_V1_ID = new PublicKey(
    "BPFLoader1111111111111111111111111111111111",
);
/** BPF loader v2 — the default non-upgradeable loader. Also exposed as `BpfLoader.programId`. */
export const BPF_LOADER_V2_ID = new PublicKey(
    "BPFLoader2111111111111111111111111111111111",
);
/** Upgradeable BPF loader — most deployed programs use this. Also exposed as `BpfLoaderUpgradeable.programId`. */
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111",
);
/** Loader V4 — the newer loader that replaces Upgradeable; 48-byte header then ELF. */
export const LOADER_V4_ID = new PublicKey(
    "LoaderV411111111111111111111111111111111111",
);

export class BpfLoader {
    static readonly programId = BPF_LOADER_V2_ID;

    /** Write ELF chunk at offset */
    static write(
        programAccount: PublicKey,
        offset: number,
        chunk: Uint8Array,
    ): Instruction {
        // `LoaderInstruction::Write { offset: u32, bytes: Vec<u8> }` — bincode
        // encodes the Vec length as a u64 (8 bytes); bytes 12..16 stay zero.
        const data = new Uint8Array(4 + 4 + 8 + chunk.length);
        const view = new DataView(data.buffer);
        view.setUint32(0, 0, true); // Write = 0
        view.setUint32(4, offset, true);
        view.setUint32(8, chunk.length, true); // Vec<u8> length (low u32 of u64)
        data.set(chunk, 16);
        return {
            programId: BpfLoader.programId,
            keys: [{ pubkey: programAccount, isSigner: true, isWritable: true }],
            data,
        };
    }

    /** Finalize a loaded program */
    static finalize(programAccount: PublicKey): Instruction {
        const data = new Uint8Array(4);
        new DataView(data.buffer).setUint32(0, 5, true); // Finalize = 5
        return {
            programId: BpfLoader.programId,
            keys: [
                { pubkey: programAccount, isSigner: true, isWritable: true },
                { pubkey: SYSVAR_RENT_ID, isSigner: false, isWritable: false },
            ],
            data,
        };
    }
}

export class BpfLoaderUpgradeable {
    static readonly programId = BPF_LOADER_UPGRADEABLE_ID;

    /** Initialize an empty buffer account */
    static initializeBuffer(
        buffer: PublicKey,
        authority: PublicKey,
    ): Instruction {
        const data = new Uint8Array(4);
        new DataView(data.buffer).setUint32(0, 0, true); // InitializeBuffer = 0
        return {
            programId: BpfLoaderUpgradeable.programId,
            keys: [
                { pubkey: buffer, isSigner: false, isWritable: true },
                { pubkey: authority, isSigner: false, isWritable: false },
            ],
            data,
        };
    }

    /** Write a chunk of ELF bytes into a buffer */
    static write(
        buffer: PublicKey,
        authority: PublicKey,
        offset: number,
        chunk: Uint8Array,
    ): Instruction {
        // bincode layout of `Write { offset: u32, bytes: Vec<u8> }`: u32 variant
        // index, u32 offset, then the Vec length as a u64 (8 bytes) before the
        // bytes. Only the low 32 bits are written; bytes 12..16 stay zero.
        const data = new Uint8Array(4 + 4 + 8 + chunk.length);
        const view = new DataView(data.buffer);
        view.setUint32(0, 1, true); // Write = 1
        view.setUint32(4, offset, true);
        view.setUint32(8, chunk.length, true); // Vec<u8> length (low u32 of u64)
        data.set(chunk, 16);
        return {
            programId: BpfLoaderUpgradeable.programId,
            keys: [
                { pubkey: buffer, isSigner: false, isWritable: true },
                { pubkey: authority, isSigner: true, isWritable: false },
            ],
            data,
        };
    }

    /** Deploy a program from a buffer with a maximum data length */
    static deployWithMaxDataLen(
        payer: PublicKey,
        programData: PublicKey,
        programId: PublicKey,
        buffer: PublicKey,
        authority: PublicKey,
        maxDataLen: number,
    ): Instruction {
        const data = new Uint8Array(4 + 8);
        const view = new DataView(data.buffer);
        view.setUint32(0, 2, true); // DeployWithMaxDataLen = 2
        view.setBigUint64(4, BigInt(maxDataLen), true);
        return {
            programId: BpfLoaderUpgradeable.programId,
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: programData, isSigner: false, isWritable: true },
                { pubkey: programId, isSigner: false, isWritable: true },
                { pubkey: buffer, isSigner: false, isWritable: true },
                { pubkey: SYSVAR_RENT_ID, isSigner: false, isWritable: false },
                { pubkey: SYSVAR_CLOCK_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: authority, isSigner: true, isWritable: false },
            ],
            data,
        };
    }

    /**
     * Change (or remove) the upgrade authority of a ProgramData or Buffer
     * account. Omitting `newAuthority` removes the authority entirely, making
     * the program immutable / non-upgradeable. The current authority must sign.
     */
    static setAuthority(
        account: PublicKey,
        currentAuthority: PublicKey,
        newAuthority?: PublicKey,
    ): Instruction {
        const data = new Uint8Array(4);
        new DataView(data.buffer).setUint32(0, 4, true); // SetAuthority = 4
        const keys = [
            { pubkey: account, isSigner: false, isWritable: true },
            { pubkey: currentAuthority, isSigner: true, isWritable: false },
        ];
        // A present new-authority account sets it; omitting it makes the
        // account immutable.
        if (newAuthority) {
            keys.push({ pubkey: newAuthority, isSigner: false, isWritable: false });
        }
        return { programId: BpfLoaderUpgradeable.programId, keys, data };
    }
}

/** Address Lookup Table program — also exposed as `AddressLookupTableProgram.programId`. */
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new PublicKey(
    "AddressLookupTab1e1111111111111111111111111",
);

// On-chain ALT account metadata size (LookupTableMeta); addresses follow at this
// offset. Mirrors solana_program::address_lookup_table::state::LOOKUP_TABLE_META_SIZE.
export const ALT_LOOKUP_TABLE_META_SIZE = 56;

/**
 * Build the raw account data for an initialized Address Lookup Table, matching
 * the on-chain `ProgramState::LookupTable(LookupTableMeta)` bincode layout:
 *   [0]   u32  discriminant (1 = LookupTable)
 *   [4]   u64  deactivation_slot (u64::MAX = active)
 *   [12]  u64  last_extended_slot
 *   [20]  u8   last_extended_slot_start_index
 *   [21]  u8 + [22..54] Option<Pubkey> authority (tag 1 = Some)
 *   [54]  u16  padding
 *   [56+] addresses (32 bytes each)
 * Used to inject a ready-to-use ALT directly into litesvm (no on-chain create).
 */
export function buildAltAccountData(
    addresses: PublicKey[],
    authority: PublicKey,
    lastExtendedSlot: number | bigint = 0,
): Uint8Array {
    const data = new Uint8Array(
        ALT_LOOKUP_TABLE_META_SIZE + addresses.length * 32,
    );
    const view = new DataView(data.buffer);
    view.setUint32(0, 1, true); // LookupTable
    view.setBigUint64(4, 0xffffffffffffffffn, true); // deactivation_slot = MAX (active)
    view.setBigUint64(12, BigInt(lastExtendedSlot), true);
    data[20] = 0; // last_extended_slot_start_index
    data[21] = 1; // authority = Some
    data.set(authority.toBytes(), 22);
    addresses.forEach((a, i) => data.set(a.toBytes(), ALT_LOOKUP_TABLE_META_SIZE + i * 32));
    return data;
}

export class AddressLookupTableProgram {
    static readonly programId = ADDRESS_LOOKUP_TABLE_PROGRAM_ID;

    /**
     * Build a CreateLookupTable instruction. The table address is a PDA of
     * `[authority, recent_slot]` under the ALT program, so the recent slot is
     * baked into the address (and validated on-chain against recent slot hashes).
     * Returns the instruction plus the derived table address.
     */
    static async createLookupTable(opts: {
        authority: PublicKey;
        payer: PublicKey;
        recentSlot: number | bigint;
    }): Promise<{ instruction: Instruction; lookupTableAddress: PublicKey }> {
        const recent_slot = BigInt(opts.recentSlot);
        const { address, bump } = await findProgramAddress(
            [opts.authority.toBytes(), toLittleEndian(recent_slot, 8)],
            AddressLookupTableProgram.programId,
        );
        // bincode: u32 variant (0 = CreateLookupTable), u64 recent_slot, u8 bump.
        const data = new Uint8Array(4 + 8 + 1);
        const view = new DataView(data.buffer);
        view.setUint32(0, 0, true);
        view.setBigUint64(4, recent_slot, true);
        data[12] = bump;
        return {
            lookupTableAddress: address,
            instruction: {
                programId: AddressLookupTableProgram.programId,
                keys: [
                    { pubkey: address, isSigner: false, isWritable: true },
                    { pubkey: opts.authority, isSigner: true, isWritable: false },
                    { pubkey: opts.payer, isSigner: true, isWritable: true },
                    {
                        pubkey: SystemProgram.programId,
                        isSigner: false,
                        isWritable: false,
                    },
                ],
                data,
            },
        };
    }

    /** Build an ExtendLookupTable instruction appending `addresses` to the table. */
    static extendLookupTable(opts: {
        lookupTable: PublicKey;
        authority: PublicKey;
        payer: PublicKey;
        addresses: PublicKey[];
    }): Instruction {
        // bincode: u32 variant (2 = ExtendLookupTable), u64 Vec length, then pubkeys.
        const data = new Uint8Array(4 + 8 + opts.addresses.length * 32);
        const view = new DataView(data.buffer);
        view.setUint32(0, 2, true);
        view.setBigUint64(4, BigInt(opts.addresses.length), true);
        opts.addresses.forEach((a, i) => data.set(a.toBytes(), 12 + i * 32));
        return {
            programId: AddressLookupTableProgram.programId,
            keys: [
                { pubkey: opts.lookupTable, isSigner: false, isWritable: true },
                { pubkey: opts.authority, isSigner: true, isWritable: false },
                { pubkey: opts.payer, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data,
        };
    }
}

// ============================================================================
// Chunked-write utility
// ============================================================================

// Max ELF bytes per BPF Loader write tx. The 1232-byte tx limit minus the
// write tx's fixed overhead (~323 bytes: 2 signatures — payer + program
// keypair — 4 account keys, blockhash, the compute-budget prefix ix, and the
// write ix header) leaves ~909 usable; 880 keeps a safe margin.
export const PROGRAM_CHUNK_SIZE = 880;

/**
 * Write a byte array in fixed-size chunks, one transaction per chunk.
 * The caller provides `buildInstruction` to produce the appropriate write
 * instruction (BpfLoader or BpfLoaderUpgradeable) for each chunk.
 */
export async function chunkedWrite(
    data: Uint8Array,
    payer: SolanaSigner,
    signers: SolanaSigner[],
    buildInstruction: (offset: number, chunk: Uint8Array) => Instruction,
    getBlockhash: () => Promise<string>,
    sendTransaction: (
        tx: VersionedTransaction,
    ) => Promise<{ signature: string; meta?: { err: unknown | null } | null }>,
    prefixInstructions: Instruction[] = [],
): Promise<string[]> {
    const payerPk = payer.getPublicKey();
    const signatures: string[] = [];
    for (let offset = 0; offset < data.length; offset += PROGRAM_CHUNK_SIZE) {
        const chunk = data.slice(
            offset,
            Math.min(offset + PROGRAM_CHUNK_SIZE, data.length),
        );
        const blockhash = await getBlockhash();
        const tx = new VersionedTransaction(
            MessageV0.fromInstructions({
                payerKey: payerPk,
                recentBlockhash: blockhash,
                instructions: [...prefixInstructions, buildInstruction(offset, chunk)],
            }),
        );
        await tx.sign([payer, ...signers]);
        const result = await sendTransaction(tx);
        if (result.meta?.err) {
            throw new Error(
                `Write failed at offset ${offset}: ${JSON.stringify(result.meta.err)}`,
            );
        }
        signatures.push(result.signature);
    }
    return signatures;
}

// ============================================================================
// Well-known programs
// ============================================================================

export const BUILTIN_PROGRAMS = new Set([
    "11111111111111111111111111111111", // System Program
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token 2022
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // ATA Program
    "ComputeBudget111111111111111111111111111111", // Compute Budget
    "SysvarRent111111111111111111111111111111111", // Rent Sysvar
    "SysvarC1ock11111111111111111111111111111111", // Clock Sysvar
    "Sysvar1nstructions1111111111111111111111111", // Instructions Sysvar
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo Program
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", // Memo Program v1
]);

// ============================================================================
// Transaction Helpers
// ============================================================================

export function decodeBase64(encoded: string): Uint8Array {
    const binary = atob(encoded);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf;
}

// ============================================================================
// Transaction Deserialization
// ============================================================================

/** Deserialize a signed transaction from wire-format bytes.
 *  Returns a `VersionedTransaction` for V0 or a `Transaction` for legacy. */
export function deserializeTransaction(
    bytes: Uint8Array,
): Transaction | VersionedTransaction {
    // Peek past the signature section to find the message version flag.
    const [numSigs, sigConsumed] = shortvecDecode(bytes, 0);
    const messageStart = sigConsumed + numSigs * 64;
    const isV0 = (bytes[messageStart] & 0x80) !== 0;
    return isV0 ? VersionedTransaction.fromBytes(bytes) : Transaction.fromBytes(bytes);
}

// ============================================================================
// Token Account Utilities
// ============================================================================

/**
 * SPL Token Account structure (165 bytes):
 * - mint: Pubkey (32 bytes) - offset 0
 * - owner: Pubkey (32 bytes) - offset 32
 * - amount: u64 (8 bytes) - offset 64
 * - delegate: COption<Pubkey> (36 bytes) - offset 72
 * - state: AccountState (1 byte) - offset 108
 * - is_native: COption<u64> (12 bytes) - offset 109
 * - delegated_amount: u64 (8 bytes) - offset 121
 * - close_authority: COption<Pubkey> (36 bytes) - offset 129
 */
export const NATIVE_SOL_ADDRESS = "So11111111111111111111111111111111111111111";
export const WSOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

export const TOKEN_ACCOUNT_SIZE = 165;
export const TOKEN_PROGRAM_PUBKEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_PUBKEY = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const TOKEN_ACCOUNT_RENT_EXEMPTION = 2_039_280;

/**
 * SPL Mint account size and layout:
 *   0-3:   mint_authority option (u32 LE, 1=Some)
 *   4-35:  mint_authority (32 bytes)
 *   36-43: supply (u64 LE)
 *   44:    decimals (u8)
 *   45:    is_initialized (u8, 1=true)
 *   46-49: freeze_authority option (u32 LE)
 *   50-81: freeze_authority (32 bytes)
 */
export const MINT_ACCOUNT_SIZE = 82;
export const MINT_ACCOUNT_RENT_EXEMPTION = 1_461_600;

export function createMintData(opts: {
    decimals: number;
    mintAuthority?: PublicKey | null;
    supply?: bigint;
    freezeAuthority?: PublicKey | null;
}): Uint8Array {
    const data = new Uint8Array(MINT_ACCOUNT_SIZE);
    const view = new DataView(data.buffer);
    if (opts.mintAuthority) {
        view.setUint32(0, 1, true);
        data.set(opts.mintAuthority.toBytes(), 4);
    }
    view.setBigUint64(36, opts.supply ?? 0n, true);
    data[44] = opts.decimals;
    data[45] = 1; // is_initialized
    if (opts.freezeAuthority) {
        view.setUint32(46, 1, true);
        data.set(opts.freezeAuthority.toBytes(), 50);
    }
    return data;
}

/** Creates a token account data buffer with the specified parameters */
export function createTokenAccountData(opts: {
    mint: PublicKey;
    owner: PublicKey;
    amount: bigint;
    delegate?: PublicKey | null;
    delegatedAmount?: bigint;
    closeAuthority?: PublicKey | null;
}): Uint8Array {
    const data = new Uint8Array(TOKEN_ACCOUNT_SIZE);
    const view = new DataView(data.buffer);

    data.set(opts.mint.toBytes(), 0);
    data.set(opts.owner.toBytes(), 32);
    view.setBigUint64(64, opts.amount, true);

    if (opts.delegate) {
        view.setUint32(72, 1, true);
        data.set(opts.delegate.toBytes(), 76);
    } else {
        view.setUint32(72, 0, true);
    }

    data[108] = 1; // Initialized
    view.setUint32(109, 0, true); // is_native = None
    view.setBigUint64(121, opts.delegatedAmount ?? 0n, true);

    if (opts.closeAuthority) {
        view.setUint32(129, 1, true);
        data.set(opts.closeAuthority.toBytes(), 133);
    } else {
        view.setUint32(129, 0, true);
    }

    return data;
}

/** Parses token account data to extract balance and other info */
export function parseTokenAccountData(data: Uint8Array): {
    mint: Uint8Array;
    owner: Uint8Array;
    amount: bigint;
    delegate: Uint8Array | null;
    state: number;
    isNative: bigint | null;
    delegatedAmount: bigint;
    closeAuthority: Uint8Array | null;
} {
    if (data.length < TOKEN_ACCOUNT_SIZE) {
        throw new Error(`Invalid token account data length: ${data.length}`);
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    return {
        mint: data.slice(0, 32),
        owner: data.slice(32, 64),
        amount: view.getBigUint64(64, true),
        delegate: view.getUint32(72, true) === 1 ? data.slice(76, 108) : null,
        state: data[108],
        isNative: view.getUint32(109, true) === 1 ? view.getBigUint64(113, true) : null,
        delegatedAmount: view.getBigUint64(121, true),
        closeAuthority: view.getUint32(129, true) === 1 ? data.slice(133, 165) : null,
    };
}

// Well-known token mints
export const KNOWN_MINTS = {
    /** USDC on Mainnet */
    USDC_MAINNET: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    /** USDC on Devnet */
    USDC_DEVNET: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    /** USDT on Mainnet */
    USDT_MAINNET: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    /** Wrapped SOL */
    WSOL: new PublicKey("So11111111111111111111111111111111111111112"),
};
