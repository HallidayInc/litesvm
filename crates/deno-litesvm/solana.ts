// Minimal Solana-like primitives for Deno without external deps
// Supports basic keypairs, message compilation, and transaction serialization

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// Base58 encoding/decoding adapted for Solana-style keys
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = BigInt(ALPHABET.length);
const ALPHABET_MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP[ALPHABET[i]] = i;
}

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = BigInt(0);
  for (const b of bytes) {
    value = (value << BigInt(8)) + BigInt(b);
  }
  let encoded = "";
  while (value > 0) {
    const mod = Number(value % BASE);
    encoded = ALPHABET[mod] + encoded;
    value /= BASE;
  }
  for (let i = 0; i < zeros; i++) encoded = "1" + encoded;
  return encoded;
}

function base58Decode(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros++;
  let acc = BigInt(0);
  for (const ch of value) {
    const digit = ALPHABET_MAP[ch];
    if (digit === undefined) throw new Error("invalid base58 character");
    acc = acc * BASE + BigInt(digit);
  }
  const bytes: number[] = [];
  while (acc > 0) {
    bytes.push(Number(acc % BigInt(256)));
    acc /= BigInt(256);
  }
  for (let i = 0; i < zeros; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

function shortvecEncode(length: number): number[] {
  const out: number[] = [];
  let rem = length;
  while (true) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      break;
    } else {
      elem |= 0x80;
      out.push(elem);
    }
  }
  return out;
}

function toLittleEndian(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  return out;
}

export class PublicKey {
  #bytes: Uint8Array;

  constructor(input: string | Uint8Array) {
    if (typeof input === "string") {
      this.#bytes = base58Decode(input);
    } else {
      this.#bytes = new Uint8Array(input);
    }
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
    return base58Encode(this.#bytes);
  }
}

// Minimal ed25519 via Web Crypto key generation
export class Keypair {
  readonly publicKey: PublicKey;
  readonly secretKey: Uint8Array;
  #privateKey: CryptoKey;

  private constructor(publicKey: PublicKey, secretKey: Uint8Array, priv: CryptoKey) {
    this.publicKey = publicKey;
    this.secretKey = secretKey;
    this.#privateKey = priv;
  }

  static async generate(): Promise<Keypair> {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const rawPriv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    return new Keypair(new PublicKey(rawPub), rawPriv, kp.privateKey);
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const payload = new Uint8Array(message);
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, this.#privateKey, payload);
    return new Uint8Array(sig);
  }
}

export interface InstructionInput {
  programId: PublicKey;
  keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

export interface CompiledMessage {
  accountKeys: PublicKey[];
  header: { requiredSignatures: number; readonlySigned: number; readonlyUnsigned: number };
  recentBlockhash: string;
  instructions: Array<{ programIdIndex: number; accounts: number[]; data: Uint8Array }>;
}

function compile(message: {
  payerKey: PublicKey;
  recentBlockhash: string;
  instructions: InstructionInput[];
}): CompiledMessage {
  const metas = new Map<string, { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>();

  const addMeta = (meta: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }) => {
    const key = meta.pubkey.toBase58();
    const existing = metas.get(key);
    if (!existing) metas.set(key, { ...meta });
    else {
      existing.isSigner = existing.isSigner || meta.isSigner;
      existing.isWritable = existing.isWritable || meta.isWritable;
    }
  };

  addMeta({ pubkey: message.payerKey, isSigner: true, isWritable: true });

  for (const ix of message.instructions) {
    addMeta({ pubkey: ix.programId, isSigner: false, isWritable: false });
    for (const key of ix.keys) addMeta(key);
  }

  const metasArr = Array.from(metas.values());
  const signers = metasArr.filter((m) => m.isSigner);
  const nonSigners = metasArr.filter((m) => !m.isSigner);
  const ordered = [
    ...signers.filter((m) => m.isWritable),
    ...signers.filter((m) => !m.isWritable),
    ...nonSigners.filter((m) => m.isWritable),
    ...nonSigners.filter((m) => !m.isWritable),
  ];

  const accountKeys = ordered.map((m) => m.pubkey);

  const readonlySigned = signers.filter((m) => !m.isWritable).length;
  const readonlyUnsigned = nonSigners.filter((m) => !m.isWritable).length;

  const indexFor = new Map<string, number>();
  ordered.forEach((meta, idx) => indexFor.set(meta.pubkey.toBase58(), idx));

  const compiledInstructions = message.instructions.map((ix) => ({
    programIdIndex: indexFor.get(ix.programId.toBase58())!,
    accounts: ix.keys.map((k) => indexFor.get(k.pubkey.toBase58())!),
    data: ix.data,
  }));

  return {
    accountKeys,
    header: {
      requiredSignatures: signers.length,
      readonlySigned,
      readonlyUnsigned,
    },
    recentBlockhash: message.recentBlockhash,
    instructions: compiledInstructions,
  };
}

function serializeMessage(compiled: CompiledMessage): Uint8Array {
  const parts: number[] = [];
  const { header } = compiled;
  parts.push(header.requiredSignatures & 0xff);
  parts.push(header.readonlySigned & 0xff);
  parts.push(header.readonlyUnsigned & 0xff);

  parts.push(...shortvecEncode(compiled.accountKeys.length));
  for (const key of compiled.accountKeys) {
    parts.push(...key.toBytes());
  }

  const blockhashBytes = base58Decode(compiled.recentBlockhash);
  if (blockhashBytes.length !== 32) throw new Error("invalid blockhash length");
  parts.push(...blockhashBytes);

  parts.push(...shortvecEncode(compiled.instructions.length));
  for (const ix of compiled.instructions) {
    parts.push(ix.programIdIndex);
    parts.push(...shortvecEncode(ix.accounts.length));
    parts.push(...ix.accounts);
    parts.push(...shortvecEncode(ix.data.length));
    parts.push(...ix.data);
  }

  return Uint8Array.from(parts);
}

export class Transaction {
  recentBlockhash: string;
  feePayer: PublicKey;
  #instructions: InstructionInput[] = [];
  #signatures: Array<{ publicKey: PublicKey; signature: Uint8Array }> = [];

  constructor(opts: { feePayer: PublicKey; recentBlockhash: string }) {
    this.recentBlockhash = opts.recentBlockhash;
    this.feePayer = opts.feePayer;
  }

  add(...ix: InstructionInput[]): this {
    this.#instructions.push(...ix);
    return this;
  }

  async sign(...signers: Keypair[]) {
    const compiled = compile({
      payerKey: this.feePayer,
      recentBlockhash: this.recentBlockhash,
      instructions: this.#instructions,
    });
    const message = serializeMessage(compiled);
    this.#signatures = await Promise.all(signers.map(async (kp) => ({
      publicKey: kp.publicKey,
      signature: await kp.sign(message),
    })));
  }

  serialize(): Uint8Array {
    if (this.#signatures.length === 0) throw new Error("transaction not signed");
    const compiled = compile({
      payerKey: this.feePayer,
      recentBlockhash: this.recentBlockhash,
      instructions: this.#instructions,
    });
    const message = serializeMessage(compiled);

    const parts: number[] = [];
    parts.push(...shortvecEncode(this.#signatures.length));
    for (const sig of this.#signatures) {
      parts.push(...sig.signature);
    }
    parts.push(...message);
    return Uint8Array.from(parts);
  }
}

export class TransactionMessage {
  #payerKey: PublicKey;
  #recentBlockhash: string;
  #instructions: InstructionInput[];

  constructor(opts: {
    payerKey: PublicKey;
    recentBlockhash: string;
    instructions: InstructionInput[];
  }) {
    this.#payerKey = opts.payerKey;
    this.#recentBlockhash = opts.recentBlockhash;
    this.#instructions = opts.instructions;
  }

  compileToV0Message(): MessageV0 {
    const compiled = compile({
      payerKey: this.#payerKey,
      recentBlockhash: this.#recentBlockhash,
      instructions: this.#instructions,
    });
    return new MessageV0(compiled);
  }
}

export class MessageV0 {
  #compiled: CompiledMessage;

  constructor(compiled: CompiledMessage) {
    this.#compiled = compiled;
  }

  get staticAccountKeys(): PublicKey[] {
    return this.#compiled.accountKeys;
  }

  serialize(): Uint8Array {
    const msg = serializeMessage(this.#compiled);
    // V0 format: [0x80 version flag][legacy message bytes][address table lookups count (0)]
    // The address table lookups section is required even when empty.
    const out = new Uint8Array(msg.length + 2);
    out[0] = 0x80; // version 0 flag
    out.set(msg, 1);
    out[msg.length + 1] = 0; // 0 address table lookups (compact-u16 of 0)
    return out;
  }
}

export class VersionedTransaction {
  readonly version = 0;
  message: MessageV0;
  #signatures: Array<{ publicKey: PublicKey; signature: Uint8Array }> = [];

  constructor(message: MessageV0) {
    this.message = message;
  }

  async sign(signers: Keypair[]) {
    const messageBytes = this.message.serialize();
    this.#signatures = await Promise.all(signers.map(async (kp) => ({
      publicKey: kp.publicKey,
      signature: await kp.sign(messageBytes),
    })));
  }

  serialize(): Uint8Array {
    if (this.#signatures.length === 0) throw new Error("transaction not signed");
    const messageBytes = this.message.serialize();
    const parts: number[] = [];
    parts.push(...shortvecEncode(this.#signatures.length));
    for (const sig of this.#signatures) parts.push(...sig.signature);
    parts.push(...messageBytes);
    return Uint8Array.from(parts);
  }
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

export class SystemProgram {
  static programId = new PublicKey(SYSTEM_PROGRAM_ID);

  static createAccount(opts: {
    fromPubkey: PublicKey;
    newAccountPubkey: PublicKey;
    lamports: number | bigint;
    space: number | bigint;
    programId: PublicKey;
  }): InstructionInput {
    const data = new Uint8Array(4 + 8 + 8 + 32);
    data.set(toLittleEndian(BigInt(0), 4), 0); // CreateAccount instruction index
    data.set(toLittleEndian(BigInt(opts.lamports), 8), 4);
    data.set(toLittleEndian(BigInt(opts.space), 8), 12);
    data.set(opts.programId.toBytes(), 20);
    return {
      programId: SystemProgram.programId,
      keys: [
        { pubkey: opts.fromPubkey, isSigner: true, isWritable: true },
        { pubkey: opts.newAccountPubkey, isSigner: true, isWritable: true },
      ],
      data,
    };
  }

  static transfer(opts: { fromPubkey: PublicKey; toPubkey: PublicKey; lamports: number | bigint }): InstructionInput {
    const data = new Uint8Array(4 + 8);
    data.set(toLittleEndian(BigInt(2), 4), 0); // Transfer instruction index
    data.set(toLittleEndian(BigInt(opts.lamports), 8), 4);
    return {
      programId: SystemProgram.programId,
      keys: [
        { pubkey: opts.fromPubkey, isSigner: true, isWritable: true },
        { pubkey: opts.toPubkey, isSigner: false, isWritable: true },
      ],
      data,
    };
  }
}

export function decodeBase58(value: string): Uint8Array {
  return base58Decode(value);
}

export function encodeBase58(bytes: Uint8Array): string {
  return base58Encode(bytes);
}

// SPL Token Program constants and utilities
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// Ed25519 curve parameters for on-curve check
const ED25519_P = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949");
const ED25519_D = BigInt("-4513249062541557337682894930092624173785641285191125241628941591882900924598840740");

/**
 * Check if a 32-byte value represents a point on the ed25519 curve
 * This is a simplified check using the curve equation
 */
function isOnCurve(bytes: Uint8Array): boolean {
  // Convert bytes to a big integer (little-endian)
  let y = BigInt(0);
  for (let i = 0; i < 32; i++) {
    y += BigInt(bytes[i]) << BigInt(8 * i);
  }

  // Clear the sign bit
  y &= (BigInt(1) << BigInt(255)) - BigInt(1);

  // Calculate y^2
  const y2 = (y * y) % ED25519_P;

  // Calculate x^2 using the curve equation: -x^2 + y^2 = 1 + d*x^2*y^2
  // Solving for x^2: x^2 = (y^2 - 1) / (d*y^2 + 1)
  const numerator = (y2 - BigInt(1) + ED25519_P) % ED25519_P;
  const denominator = ((ED25519_D * y2 % ED25519_P) + BigInt(1) + ED25519_P) % ED25519_P;

  // Calculate modular inverse of denominator
  const denominatorInverse = modPow(denominator, ED25519_P - BigInt(2), ED25519_P);
  const x2 = (numerator * denominatorInverse) % ED25519_P;

  // Check if x^2 has a square root (is a quadratic residue)
  // Using Euler's criterion: x^((p-1)/2) ≡ 1 (mod p) if x is a QR
  const exponent = (ED25519_P - BigInt(1)) / BigInt(2);
  const result = modPow(x2, exponent, ED25519_P);

  return result === BigInt(1) || x2 === BigInt(0);
}

/**
 * Modular exponentiation: (base^exp) % mod
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1);
  base = base % mod;
  while (exp > 0) {
    if (exp % BigInt(2) === BigInt(1)) {
      result = (result * base) % mod;
    }
    exp = exp / BigInt(2);
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Creates a program address from seeds and a program ID
 */
async function createProgramAddress(
  seeds: Uint8Array[],
  programId: PublicKey,
): Promise<PublicKey> {
  const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

  // Concatenate all seeds + programId + marker
  let totalLength = 0;
  for (const seed of seeds) totalLength += seed.length;
  totalLength += 32 + PDA_MARKER.length;

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const seed of seeds) {
    buffer.set(seed, offset);
    offset += seed.length;
  }
  buffer.set(programId.toBytes(), offset);
  offset += 32;
  buffer.set(PDA_MARKER, offset);

  // SHA256 hash
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  const hashBytes = new Uint8Array(hash);

  // Check if point is on curve - PDAs must be OFF curve
  if (isOnCurve(hashBytes)) {
    throw new Error("Invalid seeds - address is on curve");
  }

  return new PublicKey(hashBytes);
}

/**
 * Derives a program address from seeds and a program ID
 */
export async function findProgramAddress(
  seeds: Uint8Array[],
  programId: PublicKey,
): Promise<[PublicKey, number]> {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      const seedsWithBump = [...seeds, new Uint8Array([bump])];
      const address = await createProgramAddress(seedsWithBump, programId);
      return [address, bump];
    } catch {
      continue;
    }
  }
  throw new Error("Unable to find valid bump seed");
}

/**
 * Gets the associated token address for a wallet and mint
 */
export async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  programId: PublicKey = new PublicKey(TOKEN_PROGRAM_ID),
): Promise<PublicKey> {
  const [address] = await findProgramAddress(
    [
      owner.toBytes(),
      programId.toBytes(),
      mint.toBytes(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return address;
}

export class TokenProgram {
  static programId = new PublicKey(TOKEN_PROGRAM_ID);

  /**
   * Initialize a new token mint
   */
  static initializeMint(opts: {
    mint: PublicKey;
    decimals: number;
    mintAuthority: PublicKey;
    freezeAuthority?: PublicKey | null;
  }): InstructionInput {
    const data = new Uint8Array(67);
    data[0] = 0; // InitializeMint instruction
    data[1] = opts.decimals;
    data.set(opts.mintAuthority.toBytes(), 2);
    if (opts.freezeAuthority) {
      data[34] = 1; // COption::Some
      data.set(opts.freezeAuthority.toBytes(), 35);
    } else {
      data[34] = 0; // COption::None
    }

    return {
      programId: TokenProgram.programId,
      keys: [
        { pubkey: opts.mint, isSigner: false, isWritable: true },
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data,
    };
  }

  /**
   * Initialize a new token account
   */
  static initializeAccount(opts: {
    account: PublicKey;
    mint: PublicKey;
    owner: PublicKey;
  }): InstructionInput {
    const data = new Uint8Array(1);
    data[0] = 1; // InitializeAccount instruction

    return {
      programId: TokenProgram.programId,
      keys: [
        { pubkey: opts.account, isSigner: false, isWritable: true },
        { pubkey: opts.mint, isSigner: false, isWritable: false },
        { pubkey: opts.owner, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data,
    };
  }

  /**
   * Mint tokens to an account
   */
  static mintTo(opts: {
    mint: PublicKey;
    destination: PublicKey;
    authority: PublicKey;
    amount: bigint | number;
  }): InstructionInput {
    const data = new Uint8Array(9);
    data[0] = 7; // MintTo instruction
    data.set(toLittleEndian(BigInt(opts.amount), 8), 1);

    return {
      programId: TokenProgram.programId,
      keys: [
        { pubkey: opts.mint, isSigner: false, isWritable: true },
        { pubkey: opts.destination, isSigner: false, isWritable: true },
        { pubkey: opts.authority, isSigner: true, isWritable: false },
      ],
      data,
    };
  }

  /**
   * Transfer tokens between accounts
   */
  static transfer(opts: {
    source: PublicKey;
    destination: PublicKey;
    owner: PublicKey;
    amount: bigint | number;
  }): InstructionInput {
    const data = new Uint8Array(9);
    data[0] = 3; // Transfer instruction
    data.set(toLittleEndian(BigInt(opts.amount), 8), 1);

    return {
      programId: TokenProgram.programId,
      keys: [
        { pubkey: opts.source, isSigner: false, isWritable: true },
        { pubkey: opts.destination, isSigner: false, isWritable: true },
        { pubkey: opts.owner, isSigner: true, isWritable: false },
      ],
      data,
    };
  }
}

export class AssociatedTokenProgram {
  static programId = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);

  /**
   * Create an associated token account
   */
  static create(opts: {
    payer: PublicKey;
    associatedToken: PublicKey;
    owner: PublicKey;
    mint: PublicKey;
  }): InstructionInput {
    return {
      programId: AssociatedTokenProgram.programId,
      keys: [
        { pubkey: opts.payer, isSigner: true, isWritable: true },
        { pubkey: opts.associatedToken, isSigner: false, isWritable: true },
        { pubkey: opts.owner, isSigner: false, isWritable: false },
        { pubkey: opts.mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TokenProgram.programId, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array(0),
    };
  }

  /**
   * Create an associated token account if it doesn't exist (idempotent)
   */
  static createIdempotent(opts: {
    payer: PublicKey;
    associatedToken: PublicKey;
    owner: PublicKey;
    mint: PublicKey;
  }): InstructionInput {
    const data = new Uint8Array(1);
    data[0] = 1; // CreateIdempotent instruction

    return {
      programId: AssociatedTokenProgram.programId,
      keys: [
        { pubkey: opts.payer, isSigner: true, isWritable: true },
        { pubkey: opts.associatedToken, isSigner: false, isWritable: true },
        { pubkey: opts.owner, isSigner: false, isWritable: false },
        { pubkey: opts.mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TokenProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    };
  }
}

