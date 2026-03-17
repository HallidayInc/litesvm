/**
 * V0 (Versioned) Transaction byte parser for Solana.
 * Parses the compact-u16 (shortvec) encoded V0 wire format
 * used by Jupiter and other Solana programs.
 *
 * No external dependencies — only uses Keypair from solana.ts for re-signing.
 */

import { Keypair, encodeBase58 } from "./solana.ts";

// ============================================================================
// Types
// ============================================================================

export interface ParsedV0Transaction {
  /** Number of signatures */
  numSignatures: number;
  /** Each signature is 64 bytes (zeros if unsigned) */
  signatures: Uint8Array[];
  /** Byte offset where the message starts (after all signatures) */
  messageOffset: number;
  /** Raw message bytes (everything from messageOffset to end) */
  messageBytes: Uint8Array;
  /** V0 message header */
  header: {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
  };
  /** Static account keys (each 32 bytes) */
  staticAccountKeys: Uint8Array[];
  /** Recent blockhash (32 bytes) */
  recentBlockhash: Uint8Array;
  /** Absolute byte offset of the blockhash within the raw transaction */
  blockhashOffset: number;
  /** Compiled instructions */
  instructions: Array<{
    programIdIndex: number;
    accountIndexes: number[];
    data: Uint8Array;
  }>;
  /** Address table lookups */
  addressTableLookups: Array<{
    accountKey: Uint8Array;
    writableIndexes: number[];
    readonlyIndexes: number[];
  }>;
}

// ============================================================================
// Compact-u16 (shortvec) decoding
// ============================================================================

/**
 * Decode a compact-u16 (shortvec) value from a byte array.
 * Inverse of the shortvecEncode function in solana.ts.
 *
 * @returns [value, bytesConsumed]
 */
export function shortvecDecode(bytes: Uint8Array, offset: number): [number, number] {
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

// ============================================================================
// V0 Transaction Parser
// ============================================================================

/**
 * Parse a serialized V0 (versioned) transaction from raw bytes.
 * This is the wire format returned by Jupiter V6 and other Solana programs.
 */
export function parseV0Transaction(bytes: Uint8Array): ParsedV0Transaction {
  let offset = 0;

  // 1. Read signature count (compact-u16)
  const [numSignatures, sigCountSize] = shortvecDecode(bytes, offset);
  offset += sigCountSize;

  // 2. Read signatures (each 64 bytes)
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < numSignatures; i++) {
    signatures.push(bytes.slice(offset, offset + 64));
    offset += 64;
  }

  // Record where the message starts (needed for signing)
  const messageOffset = offset;

  // 3. Read version prefix byte (must be 0x80 for V0)
  const versionPrefix = bytes[offset];
  if ((versionPrefix & 0x80) === 0) {
    throw new Error(`Expected V0 transaction (prefix 0x80), got 0x${versionPrefix.toString(16)}`);
  }
  const version = versionPrefix & 0x7f;
  if (version !== 0) {
    throw new Error(`Unsupported transaction version: ${version}`);
  }
  offset++;

  // 4. Read message header (3 bytes)
  const header = {
    numRequiredSignatures: bytes[offset],
    numReadonlySignedAccounts: bytes[offset + 1],
    numReadonlyUnsignedAccounts: bytes[offset + 2],
  };
  offset += 3;

  // 5. Read static account keys
  const [numStaticKeys, staticKeysSize] = shortvecDecode(bytes, offset);
  offset += staticKeysSize;

  const staticAccountKeys: Uint8Array[] = [];
  for (let i = 0; i < numStaticKeys; i++) {
    staticAccountKeys.push(bytes.slice(offset, offset + 32));
    offset += 32;
  }

  // 6. Read recent blockhash (32 bytes)
  const blockhashOffset = offset;
  const recentBlockhash = bytes.slice(offset, offset + 32);
  offset += 32;

  // 7. Read instructions
  const [numInstructions, instrCountSize] = shortvecDecode(bytes, offset);
  offset += instrCountSize;

  const instructions: ParsedV0Transaction["instructions"] = [];
  for (let i = 0; i < numInstructions; i++) {
    const programIdIndex = bytes[offset];
    offset++;

    const [numAccounts, accCountSize] = shortvecDecode(bytes, offset);
    offset += accCountSize;
    const accountIndexes: number[] = [];
    for (let j = 0; j < numAccounts; j++) {
      accountIndexes.push(bytes[offset]);
      offset++;
    }

    const [dataLength, dataLenSize] = shortvecDecode(bytes, offset);
    offset += dataLenSize;
    const data = bytes.slice(offset, offset + dataLength);
    offset += dataLength;

    instructions.push({ programIdIndex, accountIndexes, data });
  }

  // 8. Read address table lookups
  const [numAltLookups, altCountSize] = shortvecDecode(bytes, offset);
  offset += altCountSize;

  const addressTableLookups: ParsedV0Transaction["addressTableLookups"] = [];
  for (let i = 0; i < numAltLookups; i++) {
    const accountKey = bytes.slice(offset, offset + 32);
    offset += 32;

    const [numWritable, writableCountSize] = shortvecDecode(bytes, offset);
    offset += writableCountSize;
    const writableIndexes: number[] = [];
    for (let j = 0; j < numWritable; j++) {
      writableIndexes.push(bytes[offset]);
      offset++;
    }

    const [numReadonly, readonlyCountSize] = shortvecDecode(bytes, offset);
    offset += readonlyCountSize;
    const readonlyIndexes: number[] = [];
    for (let j = 0; j < numReadonly; j++) {
      readonlyIndexes.push(bytes[offset]);
      offset++;
    }

    addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
  }

  // Extract message bytes (everything from messageOffset to end)
  const messageBytes = bytes.slice(messageOffset);

  return {
    numSignatures,
    signatures,
    messageOffset,
    messageBytes,
    header,
    staticAccountKeys,
    recentBlockhash,
    blockhashOffset,
    instructions,
    addressTableLookups,
  };
}

// ============================================================================
// Address Lookup Table (ALT) parsing
// ============================================================================

/** Size of the ALT account metadata header */
const ALT_METADATA_SIZE = 56;

/**
 * Parse an Address Lookup Table account's data to extract the stored addresses.
 * ALT layout: [56 bytes metadata][N × 32 bytes addresses]
 */
export function parseAltAccount(data: Uint8Array): Uint8Array[] {
  const addresses: Uint8Array[] = [];
  for (let i = ALT_METADATA_SIZE; i + 32 <= data.length; i += 32) {
    addresses.push(data.slice(i, i + 32));
  }
  return addresses;
}

/**
 * Extract all ALT account addresses from a parsed V0 transaction.
 * These are the ALT accounts themselves (not the addresses stored in them).
 */
export function extractAltAddresses(parsed: ParsedV0Transaction): Uint8Array[] {
  return parsed.addressTableLookups.map((lookup) => lookup.accountKey);
}

/**
 * Given a parsed V0 transaction and resolved ALT data, produce the complete
 * list of all account keys that the transaction touches:
 * 1. Static account keys (from the message)
 * 2. ALT-derived writable accounts
 * 3. ALT-derived readonly accounts
 */
export function resolveAllAccounts(
  parsed: ParsedV0Transaction,
  resolvedAlts: Map<string, Uint8Array[]>,
): Uint8Array[] {
  const accounts: Uint8Array[] = [...parsed.staticAccountKeys];

  for (const lookup of parsed.addressTableLookups) {
    const altKey = encodeBase58(lookup.accountKey);
    const altAddresses = resolvedAlts.get(altKey);
    if (!altAddresses) {
      throw new Error(`ALT ${altKey} not resolved`);
    }
    for (const idx of lookup.writableIndexes) {
      if (idx >= altAddresses.length) {
        throw new Error(`ALT ${altKey}: writable index ${idx} out of range (${altAddresses.length} entries)`);
      }
      accounts.push(altAddresses[idx]);
    }
    for (const idx of lookup.readonlyIndexes) {
      if (idx >= altAddresses.length) {
        throw new Error(`ALT ${altKey}: readonly index ${idx} out of range (${altAddresses.length} entries)`);
      }
      accounts.push(altAddresses[idx]);
    }
  }

  return accounts;
}

// ============================================================================
// Transaction modification (blockhash replacement + re-signing)
// ============================================================================

/**
 * Replace the blockhash in a raw V0 transaction.
 * Returns a new Uint8Array with the blockhash swapped.
 */
export function replaceBlockhash(
  rawTx: Uint8Array,
  parsed: ParsedV0Transaction,
  newBlockhash: Uint8Array,
): Uint8Array {
  if (newBlockhash.length !== 32) {
    throw new Error(`Blockhash must be 32 bytes, got ${newBlockhash.length}`);
  }
  const modified = new Uint8Array(rawTx);
  modified.set(newBlockhash, parsed.blockhashOffset);
  return modified;
}

/**
 * Sign a raw V0 transaction with a keypair.
 * Clears all existing signatures, then signs the message with the
 * provided signer and places the 64-byte signature at slot 0 (fee payer).
 */
export async function signRawV0Transaction(
  rawTx: Uint8Array,
  parsed: ParsedV0Transaction,
  signer: Keypair,
): Promise<Uint8Array> {
  const modified = new Uint8Array(rawTx);

  // Clear all existing signatures (set to zeros)
  const sigStart = rawTx.length - parsed.messageBytes.length - (parsed.numSignatures * 64);
  for (let i = 0; i < parsed.numSignatures * 64; i++) {
    modified[sigStart + i] = 0;
  }

  // Re-extract message bytes from the modified tx (blockhash may have changed)
  const messageBytes = modified.slice(parsed.messageOffset);

  // Sign the message
  const signature = await signer.sign(messageBytes);

  // Place signature at slot 0 (fee payer position)
  modified.set(signature, sigStart);

  return modified;
}
