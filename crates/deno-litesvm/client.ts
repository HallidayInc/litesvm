import {
  LiteSvm,
  ClockInfo,
  EpochScheduleInfo,
  SerializableAccount,
  SimulationResultEnvelope,
  SimulationResultOk,
  SimulationResultErr,
  TransactionResultEnvelope,
  TransactionResultOk,
  TransactionResultErr,
} from "./mod.ts";
import {
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  SystemProgram,
  findProgramAddress,
  encodeBase58,
  decodeBase58,
} from "./solana.ts";

/** BPF Loader program IDs */
const BPF_LOADER_ID = new PublicKey("BPFLoader2111111111111111111111111111111111");
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Known program IDs that don't need to be fetched */
const BUILTIN_PROGRAMS = new Set([
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
// RPC Response Types
// ============================================================================

export type Commitment = "processed" | "confirmed" | "finalized";

export interface RpcSignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus: Commitment | null;
}

export interface RpcTransactionMeta {
  err: unknown | null;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  innerInstructions: Array<{
    index: number;
    instructions: Array<{
      programIdIndex: number;
      accounts: number[];
      data: string;
    }>;
  }> | null;
  logMessages: string[] | null;
  preTokenBalances: unknown[];
  postTokenBalances: unknown[];
  computeUnitsConsumed?: number;
  returnData?: {
    programId: string;
    data: [string, string]; // [base64Data, encoding]
  } | null;
}

export interface RpcTransactionResponse {
  slot: number;
  transaction: unknown;
  meta: RpcTransactionMeta | null;
  blockTime: number | null;
}

export interface RpcSimulateTransactionResult {
  context: { slot: number };
  value: {
    err: unknown | null;
    logs: string[] | null;
    accounts: Array<{
      data: [string, string]; // [base64Data, encoding]
      executable: boolean;
      lamports: number;
      owner: string;
      rentEpoch: number;
      space: number;
    } | null> | null;
    unitsConsumed?: number;
    returnData?: {
      programId: string;
      data: [string, string];
    } | null;
  };
}

export interface RpcTokenAmount {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}

export interface RpcKeyedAccount {
  pubkey: string;
  account: {
    data: [string, string]; // [base64Data, encoding]
    executable: boolean;
    lamports: number;
    owner: string;
    rentEpoch: number;
    space: number;
  };
}

export interface RpcBlockResponse {
  blockhash: string;
  previousBlockhash: string;
  parentSlot: number;
  transactions?: Array<{
    transaction: unknown;
    meta: RpcTransactionMeta | null;
  }>;
  rewards?: unknown[];
  blockTime: number | null;
  blockHeight: number | null;
}

export interface RpcEpochInfo {
  absoluteSlot: number;
  blockHeight: number;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  transactionCount?: number;
}

export interface RpcVersionInfo {
  "solana-core": string;
  "feature-set": number;
}

export interface RpcSignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus: Commitment | null;
}

export interface RpcSupplyValue {
  total: number;
  circulating: number;
  nonCirculating: number;
  nonCirculatingAccounts: string[];
}

export interface RpcPrioritizationFee {
  slot: number;
  prioritizationFee: number;
}

// ============================================================================
// Client Options & Interfaces
// ============================================================================

export interface SendOptions {
  skipPreflight?: boolean;
  /** Commitment level for confirmation (default: "confirmed") */
  commitment?: Commitment;
  /** Timeout in milliseconds for confirmation (default: 60000) */
  confirmationTimeout?: number;
}

export interface DeployProgramOptions {
  /** Deploy as upgradeable (BPF Loader Upgradeable). Default: false (BPF Loader 2). */
  upgradeable?: boolean;
  /** Upgrade authority for upgradeable programs. Defaults to payer if not specified. */
  upgradeAuthority?: Keypair;
  /** Payer keypair for funding accounts. Required for RpcClient. */
  payer?: Keypair;
}

export interface DeployProgramResult {
  programId: PublicKey;
  /** ProgramData account address (only for upgradeable programs) */
  programDataAddress?: PublicKey;
}

export interface Client {
  latestBlockhash(): Promise<string>;
  requestAirdrop(pubkey: PublicKey, lamports: number): Promise<string>;
  getAccount(pubkey: PublicKey): Promise<SerializableAccount | null>;
  sendTransaction(
    tx: Transaction | VersionedTransaction,
    options?: SendOptions,
  ): Promise<TransactionResultEnvelope>;
  simulateTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<SimulationResultEnvelope>;
  getBalance(pubkey: PublicKey): Promise<number>;
  getMinimumBalanceForRentExemption(dataLength: number): Promise<number>;
  getTokenAccountBalance(tokenAccount: PublicKey): Promise<RpcTokenAmount>;
  getSlot(): Promise<number>;
  getBlockHeight(): Promise<number>;
  isBlockhashValid(blockhash: string): Promise<boolean>;
  getSignatureStatuses(signatures: string[]): Promise<(RpcSignatureStatus | null)[]>;
  getTransaction(signature: string): Promise<RpcTransactionResponse | null>;
  // New transport-level methods (previously RPC-only)
  getHealth(): Promise<string>;
  getVersion(): Promise<RpcVersionInfo>;
  getEpochInfo(): Promise<RpcEpochInfo>;
  getTokenSupply(mint: PublicKey): Promise<RpcTokenAmount>;
  getTransactionCount(): Promise<number>;
  getGenesisHash(): Promise<string>;
  getProgramAccounts(
    programId: PublicKey,
    opts?: { filters?: Array<{ memcmp?: { offset: number; bytes: string }; dataSize?: number }> },
  ): Promise<RpcKeyedAccount[]>;
  getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey } | { programId: PublicKey },
  ): Promise<RpcKeyedAccount[]>;
  // RPC-delegated methods (always available since RPC endpoint is required)
  getBlock(
    slot: number,
    opts?: { transactionDetails?: "full" | "signatures" | "none" },
  ): Promise<RpcBlockResponse | null>;
  getSignaturesForAddress(
    address: PublicKey,
    opts?: { limit?: number; before?: string; until?: string },
  ): Promise<RpcSignatureInfo[]>;
  getSupply(): Promise<RpcSupplyValue>;
  getFeeForMessage(message: string): Promise<number | null>;
  getRecentPrioritizationFees(addresses?: PublicKey[]): Promise<RpcPrioritizationFee[]>;
  deployProgram(
    programKeypair: Keypair,
    elfBytes: Uint8Array,
    opts?: DeployProgramOptions,
  ): Promise<DeployProgramResult>;
}

// ============================================================================
// Constants
// ============================================================================

const SYSVAR_RENT_ID = new PublicKey("SysvarRent111111111111111111111111111111111");
const SYSVAR_CLOCK_ID = new PublicKey("SysvarC1ock11111111111111111111111111111111");

/** Max data payload per BPF Loader write transaction (~1232 byte tx limit). */
const PROGRAM_CHUNK_SIZE = 1000;

/** Header size for UpgradeableLoaderState::ProgramData */
const PROGRAM_DATA_HEADER_SIZE = 45;

/** Header size for UpgradeableLoaderState::Buffer */
const BUFFER_HEADER_SIZE = 37;

// ============================================================================
// BPF Loader Instruction Builders
// ============================================================================

/** BPF Loader 2 Write instruction: write ELF chunk at offset */
function bpfLoaderWrite(
  programAccount: PublicKey,
  offset: number,
  chunk: Uint8Array,
): { programId: PublicKey; keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>; data: Uint8Array } {
  const data = new Uint8Array(4 + 4 + 4 + chunk.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0, true); // Write = 0
  view.setUint32(4, offset, true);
  view.setUint32(8, chunk.length, true);
  data.set(chunk, 12);
  return {
    programId: BPF_LOADER_ID,
    keys: [{ pubkey: programAccount, isSigner: true, isWritable: true }],
    data,
  };
}

/** BPF Loader 2 Finalize instruction */
function bpfLoaderFinalize(
  programAccount: PublicKey,
): { programId: PublicKey; keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>; data: Uint8Array } {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, 5, true); // Finalize = 5
  return {
    programId: BPF_LOADER_ID,
    keys: [
      { pubkey: programAccount, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_RENT_ID, isSigner: false, isWritable: false },
    ],
    data,
  };
}

/** BPF Loader Upgradeable: InitializeBuffer */
function upgradeableInitializeBuffer(
  buffer: PublicKey,
  authority: PublicKey,
): { programId: PublicKey; keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>; data: Uint8Array } {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, 0, true); // InitializeBuffer = 0
  return {
    programId: BPF_LOADER_UPGRADEABLE_ID,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
    ],
    data,
  };
}

/** BPF Loader Upgradeable: Write chunk to buffer */
function upgradeableWrite(
  buffer: PublicKey,
  authority: PublicKey,
  offset: number,
  chunk: Uint8Array,
): { programId: PublicKey; keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>; data: Uint8Array } {
  const data = new Uint8Array(4 + 4 + 4 + chunk.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true); // Write = 1
  view.setUint32(4, offset, true);
  view.setUint32(8, chunk.length, true);
  data.set(chunk, 12);
  return {
    programId: BPF_LOADER_UPGRADEABLE_ID,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/** BPF Loader Upgradeable: DeployWithMaxDataLen */
function upgradeableDeployWithMaxDataLen(
  payer: PublicKey,
  programData: PublicKey,
  programId: PublicKey,
  buffer: PublicKey,
  authority: PublicKey,
  maxDataLen: number,
): { programId: PublicKey; keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>; data: Uint8Array } {
  const data = new Uint8Array(4 + 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // DeployWithMaxDataLen = 2
  view.setBigUint64(4, BigInt(maxDataLen), true);
  return {
    programId: BPF_LOADER_UPGRADEABLE_ID,
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

// ============================================================================
// Helpers
// ============================================================================

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

function normalizeAccount(value: unknown): SerializableAccount | null {
  if (!value || typeof value !== "object") return null;

  if (value instanceof Uint8Array) return null;

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
  const rentEpoch = (rawRentEpoch !== undefined && rawRentEpoch > Number.MAX_SAFE_INTEGER)
    ? 0
    : (rawRentEpoch ?? 0);

  if (
    typeof lamports === "number" && typeof executable === "boolean" &&
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

function isVersioned(tx: Transaction | VersionedTransaction): tx is VersionedTransaction {
  return "version" in tx;
}

function serializeTx(tx: Transaction | VersionedTransaction): string {
  const bytes = tx.serialize();
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function deserializeTx(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

// ============================================================================
// LocalClient Options
// ============================================================================

/**
 * Options for LocalClient
 */
export interface LocalClientOptions {
  /** LiteSVM instance to use */
  svm?: LiteSvm;
  /** RPC endpoint for forking and RPC-only methods (required) */
  rpcEndpoint: string;
  /** Whether to automatically fetch missing accounts from RPC */
  autoFetchAccounts?: boolean;
}

// ============================================================================
// JsonRpcClient — typed wrapper around Solana JSON-RPC
// ============================================================================

/**
 * Shared JSON-RPC client for making calls to Solana nodes.
 * Provides typed methods for all standard Solana RPC endpoints.
 * Used by both RpcClient and LocalClient (for forking).
 */
class JsonRpcClient {
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

  // --------------------------------------------------------------------------
  // Account & Balance
  // --------------------------------------------------------------------------

  /** Fetch a single account */
  async getAccount(pubkey: PublicKey): Promise<SerializableAccount | null> {
    const result = await this.call<{ value: unknown }>(
      "getAccountInfo",
      [pubkey.toBase58(), { encoding: "base64" }],
    );
    return normalizeAccount(result.value);
  }

  /** Fetch multiple accounts in a single RPC call */
  async getMultipleAccounts(pubkeys: PublicKey[]): Promise<Map<string, SerializableAccount | null>> {
    const addresses = pubkeys.map((pk) => pk.toBase58());
    const result = await this.call<{ value: unknown[] }>(
      "getMultipleAccounts",
      [addresses, { encoding: "base64" }],
    );

    const accountMap = new Map<string, SerializableAccount | null>();
    for (let i = 0; i < pubkeys.length; i++) {
      const account = normalizeAccount(result.value[i]);
      accountMap.set(pubkeys[i].toBase58(), account);
    }
    return accountMap;
  }

  /** Fetch program data for upgradeable programs */
  async getProgramData(programId: PublicKey): Promise<{
    programAccount: SerializableAccount | null;
    programDataAccount: SerializableAccount | null;
    programDataAddress: PublicKey | null;
  }> {
    const programAccount = await this.getAccount(programId);

    if (!programAccount || !programAccount.executable) {
      return { programAccount, programDataAccount: null, programDataAddress: null };
    }

    // Check if this is an upgradeable program (owner is BPF Loader Upgradeable)
    const ownerStr = new PublicKey(programAccount.owner).toBase58();
    if (ownerStr === BPF_LOADER_UPGRADEABLE_ID.toBase58()) {
      // Parse the program account data to get programdata address
      // First 4 bytes are the account type (should be 2 for Program)
      // Next 32 bytes are the programdata address
      if (programAccount.data.length >= 36) {
        const programDataBytes = programAccount.data.slice(4, 36);
        const programDataAddress = new PublicKey(programDataBytes);
        const programDataAccount = await this.getAccount(programDataAddress);
        return { programAccount, programDataAccount, programDataAddress };
      }
    }

    return { programAccount, programDataAccount: null, programDataAddress: null };
  }

  /** Get account balance in lamports */
  async getBalance(pubkey: PublicKey, commitment?: Commitment): Promise<number> {
    const result = await this.call<{ context: { slot: number }; value: number }>(
      "getBalance",
      [pubkey.toBase58(), { commitment: commitment ?? "confirmed" }],
    );
    return result.value;
  }

  /** Get minimum lamports required for rent exemption */
  async getMinimumBalanceForRentExemption(dataLength: number, commitment?: Commitment): Promise<number> {
    return this.call<number>(
      "getMinimumBalanceForRentExemption",
      [dataLength, { commitment: commitment ?? "confirmed" }],
    );
  }

  /** Get token account balance */
  async getTokenAccountBalance(tokenAccount: PublicKey, commitment?: Commitment): Promise<RpcTokenAmount> {
    const result = await this.call<{ context: { slot: number }; value: RpcTokenAmount }>(
      "getTokenAccountBalance",
      [tokenAccount.toBase58(), { commitment: commitment ?? "confirmed" }],
    );
    return result.value;
  }

  /** Get total supply of a token mint */
  async getTokenSupply(mint: PublicKey, commitment?: Commitment): Promise<RpcTokenAmount> {
    const result = await this.call<{ context: { slot: number }; value: RpcTokenAmount }>(
      "getTokenSupply",
      [mint.toBase58(), { commitment: commitment ?? "confirmed" }],
    );
    return result.value;
  }

  /** Get all token accounts owned by an address, filtered by mint or program */
  async getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey } | { programId: PublicKey },
    commitment?: Commitment,
  ): Promise<RpcKeyedAccount[]> {
    const filterParam = "mint" in filter
      ? { mint: filter.mint.toBase58() }
      : { programId: filter.programId.toBase58() };
    const result = await this.call<{ context: { slot: number }; value: RpcKeyedAccount[] }>(
      "getTokenAccountsByOwner",
      [owner.toBase58(), filterParam, { encoding: "base64", commitment: commitment ?? "confirmed" }],
    );
    return result.value;
  }

  /** Get all accounts owned by a program */
  async getProgramAccounts(
    programId: PublicKey,
    opts?: {
      filters?: Array<{ memcmp?: { offset: number; bytes: string }; dataSize?: number }>;
      commitment?: Commitment;
    },
  ): Promise<RpcKeyedAccount[]> {
    const config: Record<string, unknown> = {
      encoding: "base64",
      commitment: opts?.commitment ?? "confirmed",
    };
    if (opts?.filters) config.filters = opts.filters;
    return this.call<RpcKeyedAccount[]>(
      "getProgramAccounts",
      [programId.toBase58(), config],
    );
  }

  // --------------------------------------------------------------------------
  // Block & Slot
  // --------------------------------------------------------------------------

  /** Get the latest blockhash */
  async getLatestBlockhash(commitment?: Commitment): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const result = await this.call<{
      context?: { slot: number };
      value?: { blockhash: string; lastValidBlockHeight: number };
      blockhash?: string;
      lastValidBlockHeight?: number;
    }>("getLatestBlockhash", [{ commitment: commitment ?? "confirmed" }]);

    // Handle both wrapped and unwrapped response formats
    if (result.value?.blockhash) return result.value;
    if (result.blockhash) return { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight ?? 0 };
    throw new Error("RPC did not return a blockhash");
  }

  /** Get block information by slot */
  async getBlock(
    slot: number,
    opts?: { commitment?: Commitment; transactionDetails?: "full" | "signatures" | "none" },
  ): Promise<RpcBlockResponse | null> {
    return this.call<RpcBlockResponse | null>(
      "getBlock",
      [slot, {
        encoding: "json",
        transactionDetails: opts?.transactionDetails ?? "full",
        commitment: opts?.commitment ?? "confirmed",
        maxSupportedTransactionVersion: 0,
      }],
    );
  }

  /** Get current block height */
  async getBlockHeight(commitment?: Commitment): Promise<number> {
    return this.call<number>(
      "getBlockHeight",
      [{ commitment: commitment ?? "confirmed" }],
    );
  }

  /** Get current slot */
  async getSlot(commitment?: Commitment): Promise<number> {
    return this.call<number>(
      "getSlot",
      [{ commitment: commitment ?? "confirmed" }],
    );
  }

  /** Check if a blockhash is still valid */
  async isBlockhashValid(blockhash: string, commitment?: Commitment): Promise<boolean> {
    const result = await this.call<{ context: { slot: number }; value: boolean }>(
      "isBlockhashValid",
      [blockhash, { commitment: commitment ?? "confirmed" }],
    );
    return result.value;
  }

  // --------------------------------------------------------------------------
  // Transaction
  // --------------------------------------------------------------------------

  /** Get full transaction details by signature */
  async getTransaction(signature: string, commitment?: Commitment): Promise<RpcTransactionResponse | null> {
    return this.call<RpcTransactionResponse | null>(
      "getTransaction",
      [signature, {
        encoding: "json",
        maxSupportedTransactionVersion: 0,
        commitment: commitment ?? "confirmed",
      }],
    );
  }

  /** Get signatures for an address */
  async getSignaturesForAddress(
    address: PublicKey,
    opts?: { limit?: number; before?: string; until?: string; commitment?: Commitment },
  ): Promise<RpcSignatureInfo[]> {
    const config: Record<string, unknown> = {
      commitment: opts?.commitment ?? "confirmed",
    };
    if (opts?.limit !== undefined) config.limit = opts.limit;
    if (opts?.before) config.before = opts.before;
    if (opts?.until) config.until = opts.until;
    return this.call<RpcSignatureInfo[]>(
      "getSignaturesForAddress",
      [address.toBase58(), config],
    );
  }

  /** Get signature statuses */
  async getSignatureStatuses(signatures: string[]): Promise<{ context: { slot: number }; value: (RpcSignatureStatus | null)[] }> {
    return this.call<{ context: { slot: number }; value: (RpcSignatureStatus | null)[] }>(
      "getSignatureStatuses",
      [signatures],
    );
  }

  /** Send an encoded transaction */
  async sendRawTransaction(
    encodedTx: string,
    opts?: { skipPreflight?: boolean; preflightCommitment?: Commitment },
  ): Promise<string> {
    return this.call<string>(
      "sendTransaction",
      [encodedTx, {
        encoding: "base64",
        skipPreflight: opts?.skipPreflight ?? false,
        preflightCommitment: opts?.preflightCommitment ?? "confirmed",
      }],
    );
  }

  /** Simulate an encoded transaction */
  async simulateRawTransaction(
    encodedTx: string,
    opts?: { commitment?: Commitment; replaceRecentBlockhash?: boolean },
  ): Promise<RpcSimulateTransactionResult> {
    return this.call<RpcSimulateTransactionResult>(
      "simulateTransaction",
      [encodedTx, {
        encoding: "base64",
        commitment: opts?.commitment ?? "confirmed",
        replaceRecentBlockhash: opts?.replaceRecentBlockhash ?? true,
      }],
    );
  }

  /** Request an airdrop (devnet/testnet only) */
  async requestAirdrop(pubkey: PublicKey, lamports: number): Promise<string> {
    return this.call<string>("requestAirdrop", [pubkey.toBase58(), lamports]);
  }

  // --------------------------------------------------------------------------
  // Network & Cluster
  // --------------------------------------------------------------------------

  /** Check node health */
  async getHealth(): Promise<string> {
    return this.call<string>("getHealth", []);
  }

  /** Get node version info */
  async getVersion(): Promise<RpcVersionInfo> {
    return this.call<RpcVersionInfo>("getVersion", []);
  }

  /** Get current epoch info */
  async getEpochInfo(commitment?: Commitment): Promise<RpcEpochInfo> {
    return this.call<RpcEpochInfo>(
      "getEpochInfo",
      [{ commitment: commitment ?? "confirmed" }],
    );
  }

  /** Get network supply information */
  async getSupply(commitment?: Commitment): Promise<RpcSupplyValue> {
    const result = await this.call<{ context: { slot: number }; value: RpcSupplyValue }>(
      "getSupply",
      [{ commitment: commitment ?? "confirmed", excludeNonCirculatingAccountsList: false }],
    );
    return result.value;
  }

  /** Get the fee for a serialized message */
  async getFeeForMessage(message: string, commitment?: Commitment): Promise<number | null> {
    const result = await this.call<{ context: { slot: number }; value: number | null }>(
      "getFeeForMessage",
      [message, { commitment: commitment ?? "confirmed" }],
    );
    return result.value;
  }

  /** Get recent prioritization fees */
  async getRecentPrioritizationFees(addresses?: PublicKey[]): Promise<RpcPrioritizationFee[]> {
    const params: unknown[] = addresses
      ? [addresses.map((a) => a.toBase58())]
      : [[]];
    return this.call<RpcPrioritizationFee[]>("getRecentPrioritizationFees", params);
  }

  /** Get the genesis hash */
  async getGenesisHash(): Promise<string> {
    return this.call<string>("getGenesisHash", []);
  }

  /** Get the transaction count */
  async getTransactionCount(commitment?: Commitment): Promise<number> {
    return this.call<number>(
      "getTransactionCount",
      [{ commitment: commitment ?? "confirmed" }],
    );
  }
}

// ============================================================================
// LocalClient — LiteSVM-backed execution with optional RPC forking
// ============================================================================

export class LocalClient implements Client {
  #svm: LiteSvm;
  #rpc: JsonRpcClient;
  #autoFetch: boolean;
  #loadedAccounts: Set<string> = new Set();

  constructor(opts: LocalClientOptions) {
    this.#svm = opts.svm ?? new LiteSvm();
    this.#rpc = new JsonRpcClient(opts.rpcEndpoint);
    this.#autoFetch = opts.autoFetchAccounts ?? true;
  }

  /** Get the underlying LiteSVM instance */
  get svm(): LiteSvm {
    return this.#svm;
  }

  /** Get the underlying JsonRpcClient */
  get rpcClient(): JsonRpcClient {
    return this.#rpc;
  }

  async latestBlockhash(): Promise<string> {
    return this.#svm.latestBlockhashString();
  }

  async requestAirdrop(pubkey: PublicKey, lamports: number): Promise<string> {
    this.#svm.airdrop(pubkey.toBytes(), lamports);
    const rand = crypto.getRandomValues(new Uint8Array(64));
    return encodeBase58(rand);
  }

  async getAccount(pubkey: PublicKey): Promise<SerializableAccount | null> {
    // First check local SVM
    const localAccount = this.#svm.getAccount(pubkey.toBytes());
    if (localAccount) return localAccount;

    // If auto-fetch is enabled, fetch from remote
    if (this.#autoFetch) {
      const remoteAccount = await this.#rpc.getAccount(pubkey);
      if (remoteAccount) {
        this.#svm.setAccount(pubkey.toBytes(), remoteAccount);
        this.#loadedAccounts.add(pubkey.toBase58());
      }
      return remoteAccount;
    }

    return null;
  }

  async getBalance(pubkey: PublicKey): Promise<number> {
    const account = await this.getAccount(pubkey);
    return account?.lamports ?? 0;
  }

  async getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
    return this.#svm.minimumBalanceForRentExemption(dataLength);
  }

  async getTokenAccountBalance(tokenAccount: PublicKey): Promise<RpcTokenAmount> {
    const balance = this.#svm.getTokenBalance(tokenAccount);
    const amountStr = balance.toString();
    return {
      amount: amountStr,
      decimals: 0,
      uiAmount: Number(balance),
      uiAmountString: amountStr,
    };
  }

  async getSlot(): Promise<number> {
    return this.#svm.getClockInfo().slot;
  }

  async getBlockHeight(): Promise<number> {
    // LiteSVM doesn't track block height separately; slot is equivalent
    return this.#svm.getClockInfo().slot;
  }

  async isBlockhashValid(_blockhash: string): Promise<boolean> {
    // In local mode, blockhashes managed by LiteSVM are always valid until expired
    return true;
  }

  async getSignatureStatuses(signatures: string[]): Promise<(RpcSignatureStatus | null)[]> {
    const clock = this.#svm.getClockInfo();
    return signatures.map((sig) => {
      let sigBytes: Uint8Array;
      try {
        sigBytes = decodeBase58(sig);
      } catch {
        return null; // Invalid base58 signature
      }
      if (sigBytes.length !== 64) return null;

      const result = this.#svm.getTransactionBySignature(sigBytes);
      if (!result) return null;
      const isErr = result.status === "err";
      return {
        slot: clock.slot,
        confirmations: null,
        err: isErr ? (result as TransactionResultErr).err : null,
        confirmationStatus: "finalized" as Commitment,
      };
    });
  }

  async getTransaction(signature: string): Promise<RpcTransactionResponse | null> {
    let sigBytes: Uint8Array;
    try {
      sigBytes = decodeBase58(signature);
    } catch {
      return null; // Invalid base58 signature
    }
    if (sigBytes.length !== 64) return null;

    const result = this.#svm.getTransactionBySignature(sigBytes);
    if (!result) return null;

    const clock = this.#svm.getClockInfo();
    const isOk = result.status === "ok";
    const meta = isOk
      ? (result as TransactionResultOk)
      : (result as TransactionResultErr).meta;

    return {
      slot: clock.slot,
      transaction: null, // Raw transaction data not available from LiteSVM history
      meta: {
        err: isOk ? null : (result as TransactionResultErr).err,
        fee: meta.fee,
        preBalances: [],
        postBalances: [],
        innerInstructions: null,
        logMessages: meta.logs,
        preTokenBalances: [],
        postTokenBalances: [],
        computeUnitsConsumed: meta.compute_units_consumed,
        returnData: null,
      },
      blockTime: Math.floor(clock.unix_timestamp),
    };
  }

  async getHealth(): Promise<string> {
    return "ok";
  }

  async getVersion(): Promise<RpcVersionInfo> {
    return { "solana-core": "litesvm", "feature-set": 0 };
  }

  async getEpochInfo(): Promise<RpcEpochInfo> {
    const clock = this.#svm.getClockInfo();
    const schedule = this.#svm.getEpochSchedule();
    const slotIndex = schedule.slots_per_epoch > 0
      ? clock.slot % schedule.slots_per_epoch
      : 0;
    return {
      absoluteSlot: clock.slot,
      blockHeight: clock.slot,
      epoch: clock.epoch,
      slotIndex,
      slotsInEpoch: schedule.slots_per_epoch,
      transactionCount: 0,
    };
  }

  async getTokenSupply(mint: PublicKey): Promise<RpcTokenAmount> {
    // Read the mint account and parse supply (bytes 36-44) and decimals (byte 44)
    const account = this.#svm.getAccount(mint.toBytes());
    if (!account || account.data.length < 82) {
      throw new Error(`Mint account ${mint.toBase58()} not found or invalid`);
    }
    const view = new DataView(
      account.data.buffer,
      account.data.byteOffset,
      account.data.byteLength,
    );
    const supply = view.getBigUint64(36, true);
    const decimals = account.data[44];
    const amountStr = supply.toString();
    const divisor = 10 ** decimals;
    const uiAmount = Number(supply) / divisor;
    return {
      amount: amountStr,
      decimals,
      uiAmount,
      uiAmountString: uiAmount.toString(),
    };
  }

  async getTransactionCount(): Promise<number> {
    return 0; // No transaction counter in LiteSVM
  }

  async getGenesisHash(): Promise<string> {
    // Use the current blockhash as a deterministic stand-in
    return this.#svm.latestBlockhashString();
  }

  async getProgramAccounts(
    programId: PublicKey,
    opts?: { filters?: Array<{ memcmp?: { offset: number; bytes: string }; dataSize?: number }> },
  ): Promise<RpcKeyedAccount[]> {
    const allKeys = this.#svm.getAllAccountKeys();
    const programIdBase58 = programId.toBase58();
    const results: RpcKeyedAccount[] = [];

    for (const keyBytes of allKeys) {
      const account = this.#svm.getAccount(keyBytes);
      if (!account) continue;

      const ownerBase58 = new PublicKey(account.owner).toBase58();
      if (ownerBase58 !== programIdBase58) continue;

      // Apply filters if any
      if (opts?.filters) {
        let matches = true;
        for (const filter of opts.filters) {
          if (filter.dataSize !== undefined && account.data.length !== filter.dataSize) {
            matches = false;
            break;
          }
          if (filter.memcmp) {
            const expected = decodeBase58(filter.memcmp.bytes);
            const slice = account.data.slice(
              filter.memcmp.offset,
              filter.memcmp.offset + expected.length,
            );
            if (slice.length !== expected.length) { matches = false; break; }
            for (let i = 0; i < expected.length; i++) {
              if (slice[i] !== expected[i]) { matches = false; break; }
            }
            if (!matches) break;
          }
        }
        if (!matches) continue;
      }

      // Convert account data to base64
      let binary = "";
      for (const byte of account.data) {
        binary += String.fromCharCode(byte);
      }
      const base64Data = btoa(binary);

      results.push({
        pubkey: new PublicKey(keyBytes).toBase58(),
        account: {
          data: [base64Data, "base64"],
          executable: account.executable,
          lamports: account.lamports,
          owner: new PublicKey(account.owner).toBase58(),
          rentEpoch: account.rent_epoch,
          space: account.data.length,
        },
      });
    }

    return results;
  }

  async getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey } | { programId: PublicKey },
  ): Promise<RpcKeyedAccount[]> {
    const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const allKeys = this.#svm.getAllAccountKeys();
    const ownerBytes = owner.toBytes();
    const results: RpcKeyedAccount[] = [];

    const filterMint = "mint" in filter ? filter.mint.toBytes() : null;
    const filterProgramId = "programId" in filter ? filter.programId.toBase58() : null;

    for (const keyBytes of allKeys) {
      const account = this.#svm.getAccount(keyBytes);
      if (!account) continue;

      // Must be a token account (owned by Token program or Token-2022)
      const ownerProgram = new PublicKey(account.owner).toBase58();
      if (ownerProgram !== TOKEN_PROGRAM_ID && ownerProgram !== TOKEN_2022_PROGRAM_ID) continue;

      // If filtering by programId, check it matches
      if (filterProgramId && ownerProgram !== filterProgramId) continue;

      // Must be at least 165 bytes (standard token account)
      if (account.data.length < 165) continue;

      // Check owner field (bytes 32-64 of token account data)
      const accountOwnerBytes = account.data.slice(32, 64);
      let ownerMatch = true;
      for (let i = 0; i < 32; i++) {
        if (accountOwnerBytes[i] !== ownerBytes[i]) { ownerMatch = false; break; }
      }
      if (!ownerMatch) continue;

      // If filtering by mint, check mint field (bytes 0-32)
      if (filterMint) {
        const mintBytes = account.data.slice(0, 32);
        let mintMatch = true;
        for (let i = 0; i < 32; i++) {
          if (mintBytes[i] !== filterMint[i]) { mintMatch = false; break; }
        }
        if (!mintMatch) continue;
      }

      // Convert to base64
      let binary = "";
      for (const byte of account.data) {
        binary += String.fromCharCode(byte);
      }
      const base64Data = btoa(binary);

      results.push({
        pubkey: new PublicKey(keyBytes).toBase58(),
        account: {
          data: [base64Data, "base64"],
          executable: account.executable,
          lamports: account.lamports,
          owner: ownerProgram,
          rentEpoch: account.rent_epoch,
          space: account.data.length,
        },
      });
    }

    return results;
  }

  // RPC-delegated methods (always available since RPC endpoint is required)

  async getBlock(
    slot: number,
    opts?: { transactionDetails?: "full" | "signatures" | "none" },
  ): Promise<RpcBlockResponse | null> {
    return this.#rpc.getBlock(slot, opts);
  }

  async getSignaturesForAddress(
    address: PublicKey,
    opts?: { limit?: number; before?: string; until?: string },
  ): Promise<RpcSignatureInfo[]> {
    return this.#rpc.getSignaturesForAddress(address, opts);
  }

  async getSupply(): Promise<RpcSupplyValue> {
    return this.#rpc.getSupply();
  }

  async getFeeForMessage(message: string): Promise<number | null> {
    return this.#rpc.getFeeForMessage(message);
  }

  async getRecentPrioritizationFees(addresses?: PublicKey[]): Promise<RpcPrioritizationFee[]> {
    return this.#rpc.getRecentPrioritizationFees(addresses);
  }

  /**
   * Ensure all accounts required by a transaction are loaded into the SVM
   */
  async #ensureAccountsLoaded(tx: Transaction | VersionedTransaction): Promise<void> {
    if (!this.#autoFetch) return;

    // Extract all account keys from the transaction
    const accountKeys = isVersioned(tx)
      ? tx.message.staticAccountKeys
      : [tx.feePayer]; // For legacy, we need to parse more carefully

    // Filter out accounts we've already loaded and builtin programs
    const accountsToFetch: PublicKey[] = [];
    for (const pk of accountKeys) {
      const pkStr = pk.toBase58();
      if (!this.#loadedAccounts.has(pkStr) && !BUILTIN_PROGRAMS.has(pkStr)) {
        // Check if already in SVM
        const existing = this.#svm.getAccount(pk.toBytes());
        if (!existing) {
          accountsToFetch.push(pk);
        } else {
          this.#loadedAccounts.add(pkStr);
        }
      }
    }

    if (accountsToFetch.length === 0) return;

    // Fetch all accounts in batch
    const accountMap = await this.#rpc.getMultipleAccounts(accountsToFetch);

    // Process fetched accounts
    const programsToLoad: PublicKey[] = [];

    for (const [pkStr, account] of accountMap) {
      if (account) {
        const pk = new PublicKey(pkStr);

        // If this is an executable account (program), we need special handling
        if (account.executable) {
          programsToLoad.push(pk);
        } else {
          // Regular account - just set it
          this.#svm.setAccount(pk.toBytes(), account);
          this.#loadedAccounts.add(pkStr);
        }
      }
    }

    // Load programs (may need to fetch program data accounts for upgradeable programs)
    for (const programId of programsToLoad) {
      await this.#loadProgram(programId);
    }
  }

  /**
   * Load a program into the SVM, handling upgradeable programs
   */
  async #loadProgram(programId: PublicKey): Promise<void> {
    const pkStr = programId.toBase58();
    if (this.#loadedAccounts.has(pkStr)) return;

    const { programAccount, programDataAccount, programDataAddress } =
      await this.#rpc.getProgramData(programId);

    if (!programAccount) return;

    const ownerStr = new PublicKey(programAccount.owner).toBase58();

    if (ownerStr === BPF_LOADER_UPGRADEABLE_ID.toBase58() && programDataAccount && programDataAddress) {
      // Upgradeable program - extract ELF from program data account
      // Skip the metadata header (45 bytes for UpgradeableLoaderState::ProgramData)
      const PROGRAM_DATA_HEADER_SIZE = 45;
      if (programDataAccount.data.length > PROGRAM_DATA_HEADER_SIZE) {
        const elfBytes = programDataAccount.data.slice(PROGRAM_DATA_HEADER_SIZE);

        // Add the program using the ELF bytes
        this.#svm.addProgram(programId.toBytes(), elfBytes);
        this.#loadedAccounts.add(pkStr);

        // Also set the program data account (needed for some operations)
        this.#svm.setAccount(programDataAddress.toBytes(), programDataAccount);
        this.#loadedAccounts.add(programDataAddress.toBase58());
      }
    } else if (ownerStr === BPF_LOADER_ID.toBase58()) {
      // Non-upgradeable program - ELF is directly in the account data
      this.#svm.addProgram(programId.toBytes(), programAccount.data);
      this.#loadedAccounts.add(pkStr);
    } else {
      // Unknown program type - just set the account
      this.#svm.setAccount(programId.toBytes(), programAccount);
      this.#loadedAccounts.add(pkStr);
    }
  }

  /**
   * Pre-load a list of account public keys into the SVM from RPC.
   * Used for externally-constructed transactions (e.g., Jupiter swap txs)
   * where #ensureAccountsLoaded can't extract keys from a parsed object.
   */
  async ensureAccountKeysLoaded(accountKeys: PublicKey[]): Promise<void> {
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

    // Batch fetch in groups of 100 (Solana RPC limit for getMultipleAccounts)
    const BATCH_SIZE = 100;
    for (let i = 0; i < accountsToFetch.length; i += BATCH_SIZE) {
      const batch = accountsToFetch.slice(i, i + BATCH_SIZE);
      const accountMap = await this.#rpc.getMultipleAccounts(batch);
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
  }

  async sendTransaction(
    tx: Transaction | VersionedTransaction,
    _options?: SendOptions,
  ): Promise<TransactionResultEnvelope> {
    // Ensure all accounts are loaded before executing
    await this.#ensureAccountsLoaded(tx);

    const bytes = tx.serialize();
    return isVersioned(tx)
      ? this.#svm.sendVersionedTransaction(bytes)
      : this.#svm.sendLegacyTransaction(bytes);
  }

  async simulateTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<SimulationResultEnvelope> {
    // Ensure all accounts are loaded before simulating
    await this.#ensureAccountsLoaded(tx);

    const bytes = tx.serialize();
    return isVersioned(tx)
      ? this.#svm.simulateVersionedTransaction(bytes)
      : this.#svm.simulateLegacyTransaction(bytes);
  }

  /** Warp the local SVM to a specific slot. */
  warpToSlot(slot: number): void {
    this.#svm.warpToSlot(slot);
  }

  /**
   * Send raw pre-serialized versioned transaction bytes directly to the SVM.
   * Used when you have pre-built transaction bytes (e.g., from Jupiter API)
   * that can't be deserialized into a VersionedTransaction object.
   */
  sendRawVersionedTransaction(rawBytes: Uint8Array): TransactionResultEnvelope {
    return this.#svm.sendVersionedTransaction(rawBytes);
  }

  async deployProgram(
    programKeypair: Keypair,
    elfBytes: Uint8Array,
    opts?: DeployProgramOptions,
  ): Promise<DeployProgramResult> {
    const upgradeable = opts?.upgradeable ?? false;

    if (!upgradeable) {
      this.#svm.addProgram(programKeypair.publicKey.toBytes(), elfBytes);
      return { programId: programKeypair.publicKey };
    }

    // Upgradeable: manually construct the two-account structure
    const [programDataAddress] = await findProgramAddress(
      [programKeypair.publicKey.toBytes()],
      BPF_LOADER_UPGRADEABLE_ID,
    );

    // ProgramData account MUST be set first — LiteSVM's set_account for
    // upgradeable programs looks up the programdata account during load_program.
    // ProgramData (45 + ELF): enum tag 3 (ProgramData) + slot + authority + ELF
    const programDataData = new Uint8Array(PROGRAM_DATA_HEADER_SIZE + elfBytes.length);
    const pdView = new DataView(programDataData.buffer);
    pdView.setUint32(0, 3, true); // ProgramData variant
    pdView.setBigUint64(4, BigInt(this.#svm.getClockInfo().slot), true);
    if (opts?.upgradeAuthority) {
      programDataData[12] = 1; // Some
      programDataData.set(opts.upgradeAuthority.publicKey.toBytes(), 13);
    } else {
      programDataData[12] = 0; // None
    }
    programDataData.set(elfBytes, PROGRAM_DATA_HEADER_SIZE);

    this.#svm.setAccount(programDataAddress.toBytes(), {
      lamports: this.#svm.minimumBalanceForRentExemption(PROGRAM_DATA_HEADER_SIZE + elfBytes.length),
      data: programDataData,
      owner: BPF_LOADER_UPGRADEABLE_ID.toBytes(),
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
      owner: BPF_LOADER_UPGRADEABLE_ID.toBytes(),
      executable: true,
      rent_epoch: 0,
    });

    return { programId: programKeypair.publicKey, programDataAddress };
  }
}

// ============================================================================
// RpcClient — remote RPC execution
// ============================================================================

export class RpcClient implements Client {
  #rpc: JsonRpcClient;

  constructor(endpoint: string) {
    this.#rpc = new JsonRpcClient(endpoint);
  }

  /** Get the underlying JsonRpcClient */
  get rpcClient(): JsonRpcClient {
    return this.#rpc;
  }

  async latestBlockhash(): Promise<string> {
    const result = await this.#rpc.getLatestBlockhash();
    return result.blockhash;
  }

  async requestAirdrop(pubkey: PublicKey, lamports: number): Promise<string> {
    const signature = await this.#rpc.requestAirdrop(pubkey, lamports);

    // Wait for airdrop confirmation
    await this.#confirmTransaction(signature, "confirmed", 60_000);

    return signature;
  }

  async getAccount(pubkey: PublicKey): Promise<SerializableAccount | null> {
    return this.#rpc.getAccount(pubkey);
  }

  async getBalance(pubkey: PublicKey): Promise<number> {
    return this.#rpc.getBalance(pubkey);
  }

  async getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
    return this.#rpc.getMinimumBalanceForRentExemption(dataLength);
  }

  async getTokenAccountBalance(tokenAccount: PublicKey): Promise<RpcTokenAmount> {
    return this.#rpc.getTokenAccountBalance(tokenAccount);
  }

  async getSlot(): Promise<number> {
    return this.#rpc.getSlot();
  }

  async getBlockHeight(): Promise<number> {
    return this.#rpc.getBlockHeight();
  }

  async isBlockhashValid(blockhash: string): Promise<boolean> {
    return this.#rpc.isBlockhashValid(blockhash);
  }

  async getSignatureStatuses(signatures: string[]): Promise<(RpcSignatureStatus | null)[]> {
    const result = await this.#rpc.getSignatureStatuses(signatures);
    return result.value;
  }

  async getTransaction(signature: string): Promise<RpcTransactionResponse | null> {
    return this.#rpc.getTransaction(signature);
  }

  async getHealth(): Promise<string> {
    return this.#rpc.getHealth();
  }

  async getVersion(): Promise<RpcVersionInfo> {
    return this.#rpc.getVersion();
  }

  async getEpochInfo(): Promise<RpcEpochInfo> {
    return this.#rpc.getEpochInfo();
  }

  async getTokenSupply(mint: PublicKey): Promise<RpcTokenAmount> {
    return this.#rpc.getTokenSupply(mint);
  }

  async getTransactionCount(): Promise<number> {
    return this.#rpc.getTransactionCount();
  }

  async getGenesisHash(): Promise<string> {
    return this.#rpc.getGenesisHash();
  }

  async getProgramAccounts(
    programId: PublicKey,
    opts?: { filters?: Array<{ memcmp?: { offset: number; bytes: string }; dataSize?: number }> },
  ): Promise<RpcKeyedAccount[]> {
    return this.#rpc.getProgramAccounts(programId, opts);
  }

  async getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey } | { programId: PublicKey },
  ): Promise<RpcKeyedAccount[]> {
    return this.#rpc.getTokenAccountsByOwner(owner, filter);
  }

  async getBlock(
    slot: number,
    opts?: { transactionDetails?: "full" | "signatures" | "none" },
  ): Promise<RpcBlockResponse | null> {
    return this.#rpc.getBlock(slot, opts);
  }

  async getSignaturesForAddress(
    address: PublicKey,
    opts?: { limit?: number; before?: string; until?: string },
  ): Promise<RpcSignatureInfo[]> {
    return this.#rpc.getSignaturesForAddress(address, opts);
  }

  async getSupply(): Promise<RpcSupplyValue> {
    return this.#rpc.getSupply();
  }

  async getFeeForMessage(message: string): Promise<number | null> {
    return this.#rpc.getFeeForMessage(message);
  }

  async getRecentPrioritizationFees(addresses?: PublicKey[]): Promise<RpcPrioritizationFee[]> {
    return this.#rpc.getRecentPrioritizationFees(addresses);
  }

  /**
   * Confirms a transaction by polling getSignatureStatuses
   */
  async #confirmTransaction(
    signature: string,
    commitment: Commitment = "confirmed",
    timeoutMs: number = 60_000,
  ): Promise<RpcSignatureStatus> {
    const startTime = Date.now();
    const commitmentLevels = ["processed", "confirmed", "finalized"];
    const targetLevel = commitmentLevels.indexOf(commitment);

    while (Date.now() - startTime < timeoutMs) {
      const statuses = await this.getSignatureStatuses([signature]);
      const status = statuses[0];

      if (status !== null) {
        if (status.err) {
          return status; // Return with error for caller to handle
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

  /**
   * Converts RPC transaction response to TransactionResultEnvelope
   */
  #buildTransactionResult(
    signature: string,
    status: RpcSignatureStatus,
    txDetails: RpcTransactionResponse | null,
  ): TransactionResultEnvelope {
    // Build metadata from transaction details
    const meta = txDetails?.meta;
    const logs = meta?.logMessages ?? [];
    const computeUnitsConsumed = meta?.computeUnitsConsumed ?? 0;
    const fee = meta?.fee ?? 0;

    // Convert inner instructions
    const innerInstructions: Array<Array<{
      instruction_index: number;
      program_id: Uint8Array;
      data: Uint8Array;
      accounts: number[];
    }>> = [];

    if (meta?.innerInstructions) {
      for (const group of meta.innerInstructions) {
        const instructions = group.instructions.map((ix) => ({
          instruction_index: group.index,
          program_id: new Uint8Array(32), // Would need account keys to resolve
          data: base64ToBytes(ix.data),
          accounts: ix.accounts,
        }));
        innerInstructions.push(instructions);
      }
    }

    // Convert return data
    let returnData = { program_id: new Array(32).fill(0), data: [] as number[] };
    if (meta?.returnData) {
      const programIdBytes = new PublicKey(meta.returnData.programId).toBytes();
      const dataBytes = base64ToBytes(meta.returnData.data[0]);
      returnData = {
        program_id: Array.from(programIdBytes),
        data: Array.from(dataBytes),
      };
    }

    // Check if transaction failed
    if (status.err || meta?.err) {
      const err = status.err ?? meta?.err;
      const result: TransactionResultErr = {
        status: "err",
        err: err as TransactionResultErr["err"],
        meta: {
          signature,
          logs,
          inner_instructions: [],
          compute_units_consumed: computeUnitsConsumed,
          return_data: returnData,
          fee,
        },
      };
      return result;
    }

    // Success case
    const result: TransactionResultOk = {
      status: "ok",
      signature,
      logs,
      inner_instructions: [],
      compute_units_consumed: computeUnitsConsumed,
      return_data: returnData,
      fee,
    };
    return result;
  }

  async sendTransaction(
    tx: Transaction | VersionedTransaction,
    options?: SendOptions,
  ): Promise<TransactionResultEnvelope> {
    const commitment = options?.commitment ?? "confirmed";
    const timeoutMs = options?.confirmationTimeout ?? 60_000;

    // Send the transaction
    const signature = await this.#rpc.sendRawTransaction(serializeTx(tx), {
      skipPreflight: options?.skipPreflight,
      preflightCommitment: commitment,
    });

    // Wait for confirmation
    const status = await this.#confirmTransaction(signature, commitment, timeoutMs);

    // Fetch full transaction details
    const txDetails = await this.#rpc.getTransaction(signature);

    // Build and return the full result envelope
    return this.#buildTransactionResult(signature, status, txDetails);
  }

  async simulateTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<SimulationResultEnvelope> {
    const result = await this.#rpc.simulateRawTransaction(serializeTx(tx));
    return this.#buildSimulationResult(tx, result);
  }

  /**
   * Converts RPC simulation response to SimulationResultEnvelope
   */
  #buildSimulationResult(
    _tx: Transaction | VersionedTransaction,
    result: RpcSimulateTransactionResult,
  ): SimulationResultEnvelope {
    const value = result.value;
    const logs = value.logs ?? [];
    const computeUnitsConsumed = value.unitsConsumed ?? 0;

    // Convert return data
    let returnData = { program_id: new Array(32).fill(0), data: [] as number[] };
    if (value.returnData) {
      const programIdBytes = new PublicKey(value.returnData.programId).toBytes();
      const dataBytes = base64ToBytes(value.returnData.data[0]);
      returnData = {
        program_id: Array.from(programIdBytes),
        data: Array.from(dataBytes),
      };
    }

    // Build metadata
    const meta = {
      signature: "", // Simulations don't produce real signatures
      logs,
      inner_instructions: [] as Array<Array<{
        instruction_index: number;
        program_id: Uint8Array;
        data: Uint8Array;
        accounts: number[];
      }>>,
      compute_units_consumed: computeUnitsConsumed,
      return_data: returnData,
      fee: 0, // Simulations don't charge fees
    };

    // Check if simulation failed
    if (value.err) {
      const errResult: SimulationResultErr = {
        status: "err",
        err: value.err as SimulationResultErr["err"],
        meta,
      };
      return errResult;
    }

    // Build post_accounts from simulation result
    const postAccounts: SimulationResultOk["post_accounts"] = [];
    if (value.accounts) {
      for (const acc of value.accounts) {
        if (acc) {
          postAccounts.push({
            pubkey: new Array(32).fill(0), // Would need to track which accounts were requested
            account: {
              lamports: acc.lamports,
              data: base64ToBytes(acc.data[0]),
              owner: new PublicKey(acc.owner).toBytes(),
              executable: acc.executable,
              rent_epoch: acc.rentEpoch,
            },
          });
        }
      }
    }

    // Success case
    const okResult: SimulationResultOk = {
      status: "ok",
      meta,
      post_accounts: postAccounts,
    };
    return okResult;
  }

  async deployProgram(
    programKeypair: Keypair,
    elfBytes: Uint8Array,
    opts?: DeployProgramOptions,
  ): Promise<DeployProgramResult> {
    const upgradeable = opts?.upgradeable ?? false;
    const payer = opts?.payer;
    if (!payer) {
      throw new Error("RpcClient.deployProgram requires opts.payer to sign transactions");
    }

    if (!upgradeable) {
      return this.#deployNonUpgradeable(payer, programKeypair, elfBytes);
    } else {
      const authority = opts?.upgradeAuthority ?? payer;
      return this.#deployUpgradeable(payer, programKeypair, elfBytes, authority);
    }
  }

  async #deployNonUpgradeable(
    payer: Keypair,
    programKeypair: Keypair,
    elfBytes: Uint8Array,
  ): Promise<DeployProgramResult> {
    // 1. Create program account
    const lamports = await this.getMinimumBalanceForRentExemption(elfBytes.length);
    const blockhash = await this.latestBlockhash();

    const createTx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: blockhash,
    }).add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: programKeypair.publicKey,
      lamports,
      space: elfBytes.length,
      programId: BPF_LOADER_ID,
    }));
    await createTx.sign(payer, programKeypair);
    const createResult = await this.sendTransaction(createTx);
    if (createResult.status !== "ok") {
      throw new Error(`Failed to create program account: ${JSON.stringify(createResult)}`);
    }

    // 2. Write ELF in chunks
    for (let offset = 0; offset < elfBytes.length; offset += PROGRAM_CHUNK_SIZE) {
      const chunk = elfBytes.slice(offset, Math.min(offset + PROGRAM_CHUNK_SIZE, elfBytes.length));
      const writeBlockhash = await this.latestBlockhash();
      const writeTx = new Transaction({
        feePayer: payer.publicKey,
        recentBlockhash: writeBlockhash,
      }).add(bpfLoaderWrite(programKeypair.publicKey, offset, chunk));
      await writeTx.sign(payer, programKeypair);
      const writeResult = await this.sendTransaction(writeTx);
      if (writeResult.status !== "ok") {
        throw new Error(`Failed to write program data at offset ${offset}: ${JSON.stringify(writeResult)}`);
      }
    }

    // 3. Finalize
    const finalizeBlockhash = await this.latestBlockhash();
    const finalizeTx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: finalizeBlockhash,
    }).add(bpfLoaderFinalize(programKeypair.publicKey));
    await finalizeTx.sign(payer, programKeypair);
    const finalizeResult = await this.sendTransaction(finalizeTx);
    if (finalizeResult.status !== "ok") {
      throw new Error(`Failed to finalize program: ${JSON.stringify(finalizeResult)}`);
    }

    return { programId: programKeypair.publicKey };
  }

  async #deployUpgradeable(
    payer: Keypair,
    programKeypair: Keypair,
    elfBytes: Uint8Array,
    authority: Keypair,
  ): Promise<DeployProgramResult> {
    const bufferKeypair = await Keypair.generate();
    const bufferSize = BUFFER_HEADER_SIZE + elfBytes.length;

    // 1. Create and initialize buffer account
    const bufferLamports = await this.getMinimumBalanceForRentExemption(bufferSize);
    const blockhash1 = await this.latestBlockhash();

    const createBufferTx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: blockhash1,
    }).add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: bufferKeypair.publicKey,
        lamports: bufferLamports,
        space: bufferSize,
        programId: BPF_LOADER_UPGRADEABLE_ID,
      }),
      upgradeableInitializeBuffer(bufferKeypair.publicKey, authority.publicKey),
    );
    await createBufferTx.sign(payer, bufferKeypair);
    const createResult = await this.sendTransaction(createBufferTx);
    if (createResult.status !== "ok") {
      throw new Error(`Failed to create buffer account: ${JSON.stringify(createResult)}`);
    }

    // 2. Write ELF to buffer in chunks
    for (let offset = 0; offset < elfBytes.length; offset += PROGRAM_CHUNK_SIZE) {
      const chunk = elfBytes.slice(offset, Math.min(offset + PROGRAM_CHUNK_SIZE, elfBytes.length));
      const writeBlockhash = await this.latestBlockhash();
      const writeTx = new Transaction({
        feePayer: payer.publicKey,
        recentBlockhash: writeBlockhash,
      }).add(upgradeableWrite(bufferKeypair.publicKey, authority.publicKey, offset, chunk));
      await writeTx.sign(payer, authority);
      const writeResult = await this.sendTransaction(writeTx);
      if (writeResult.status !== "ok") {
        throw new Error(`Failed to write buffer at offset ${offset}: ${JSON.stringify(writeResult)}`);
      }
    }

    // 3. Derive programdata PDA
    const [programDataAddress] = await findProgramAddress(
      [programKeypair.publicKey.toBytes()],
      BPF_LOADER_UPGRADEABLE_ID,
    );

    // 4. Deploy: create program account + link to buffer
    const programDataSize = PROGRAM_DATA_HEADER_SIZE + elfBytes.length;
    const programLamports = await this.getMinimumBalanceForRentExemption(36);
    const deployBlockhash = await this.latestBlockhash();

    const deployTx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: deployBlockhash,
    }).add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: programKeypair.publicKey,
        lamports: programLamports,
        space: 36,
        programId: BPF_LOADER_UPGRADEABLE_ID,
      }),
      upgradeableDeployWithMaxDataLen(
        payer.publicKey,
        programDataAddress,
        programKeypair.publicKey,
        bufferKeypair.publicKey,
        authority.publicKey,
        programDataSize,
      ),
    );
    await deployTx.sign(payer, programKeypair, authority);
    const deployResult = await this.sendTransaction(deployTx);
    if (deployResult.status !== "ok") {
      throw new Error(`Failed to deploy program: ${JSON.stringify(deployResult)}`);
    }

    return { programId: programKeypair.publicKey, programDataAddress };
  }
}

// ============================================================================
// SolanaLikeClient — unified public API
// ============================================================================

// ============================================================================
// Exported utility functions
// ============================================================================

export function deserializeTransaction(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function decodeBase64Transaction(encoded: string): Uint8Array {
  return deserializeTx(encoded);
}

export function encodeTransaction(tx: Transaction | VersionedTransaction): string {
  return serializeTx(tx);
}
