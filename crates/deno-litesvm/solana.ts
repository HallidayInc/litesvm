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
    const out = new Uint8Array(msg.length + 1);
    out[0] = 0x80; // version 0 flag
    out.set(msg, 1);
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

