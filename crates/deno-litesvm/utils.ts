import { PublicKey } from "./solana.ts";

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
export const TOKEN_ACCOUNT_SIZE = 165;
export const TOKEN_PROGRAM_PUBKEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_ACCOUNT_RENT_EXEMPTION = 2_039_280;

/**
 * Creates a token account data buffer with the specified parameters
 */
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

  // mint (32 bytes at offset 0)
  data.set(opts.mint.toBytes(), 0);

  // owner (32 bytes at offset 32)
  data.set(opts.owner.toBytes(), 32);

  // amount (8 bytes at offset 64)
  view.setBigUint64(64, opts.amount, true);

  // delegate (COption<Pubkey> - 36 bytes at offset 72)
  if (opts.delegate) {
    view.setUint32(72, 1, true); // Some
    data.set(opts.delegate.toBytes(), 76);
  } else {
    view.setUint32(72, 0, true); // None
  }

  // state (1 byte at offset 108) - 1 = Initialized
  data[108] = 1;

  // is_native (COption<u64> - 12 bytes at offset 109) - None for non-native
  view.setUint32(109, 0, true);

  // delegated_amount (8 bytes at offset 121)
  view.setBigUint64(121, opts.delegatedAmount ?? BigInt(0), true);

  // close_authority (COption<Pubkey> - 36 bytes at offset 129)
  if (opts.closeAuthority) {
    view.setUint32(129, 1, true); // Some
    data.set(opts.closeAuthority.toBytes(), 133);
  } else {
    view.setUint32(129, 0, true); // None
  }

  return data;
}

/**
 * Parses token account data to extract balance and other info
 */
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

  const mint = data.slice(0, 32);
  const owner = data.slice(32, 64);
  const amount = view.getBigUint64(64, true);

  const delegateOption = view.getUint32(72, true);
  const delegate = delegateOption === 1 ? data.slice(76, 108) : null;

  const state = data[108];

  const isNativeOption = view.getUint32(109, true);
  const isNative = isNativeOption === 1 ? view.getBigUint64(113, true) : null;

  const delegatedAmount = view.getBigUint64(121, true);

  const closeAuthorityOption = view.getUint32(129, true);
  const closeAuthority = closeAuthorityOption === 1 ? data.slice(133, 165) : null;

  return {
    mint,
    owner,
    amount,
    delegate,
    state,
    isNative,
    delegatedAmount,
    closeAuthority,
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
