import {
  LiteSvm,
  SerializableAccount,
  SimulationResultEnvelope,
  TransactionResultEnvelope,
} from "./mod.ts";
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  encodeBase58,
} from "./solana.ts";

export interface SolanaLikeClientOptions {
  svm?: LiteSvm;
  endpoint?: string;
}

export interface AccountInfoResponse {
  address: PublicKey;
  account: SerializableAccount | null;
}

export interface SendOptions {
  skipPreflight?: boolean;
}

interface ClientTransport {
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
}

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
  const rentEpoch = (candidate.rent_epoch ?? candidate.rentEpoch) as
    | number
    | undefined;
  const owner = candidate.owner;
  const data = candidate.data;

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

function normalizeSendResult(result: unknown): TransactionResultEnvelope {
  if (result && typeof result === "object" && "status" in result) {
    return result as TransactionResultEnvelope;
  }
  if (typeof result === "string") {
    return { status: "ok", signature: result };
  }
  return { status: "ok", value: result };
}

function normalizeSimulationResult(result: unknown): SimulationResultEnvelope {
  if (result && typeof result === "object" && "status" in result) {
    return result as SimulationResultEnvelope;
  }

  const candidate = result as { value?: { err?: unknown } } | undefined;
  if (candidate?.value) {
    return { status: candidate.value.err ? "err" : "ok", value: result };
  }

  return { status: "ok", value: result };
}

function isVersioned(tx: Transaction | VersionedTransaction): tx is VersionedTransaction {
  return "version" in tx;
}

class LocalTransport implements ClientTransport {
  #svm: LiteSvm;

  constructor(svm?: LiteSvm) {
    this.#svm = svm ?? new LiteSvm();
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
    return this.#svm.getAccount(pubkey.toBytes());
  }

  async sendTransaction(
    tx: Transaction | VersionedTransaction,
    _options?: SendOptions,
  ): Promise<TransactionResultEnvelope> {
    const bytes = tx.serialize();
    return isVersioned(tx)
      ? this.#svm.sendVersionedTransaction(bytes)
      : this.#svm.sendLegacyTransaction(bytes);
  }

  async simulateTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<SimulationResultEnvelope> {
    const bytes = tx.serialize();
    return isVersioned(tx)
      ? this.#svm.simulateVersionedTransaction(bytes)
      : this.#svm.simulateLegacyTransaction(bytes);
  }
}

class RpcTransport implements ClientTransport {
  #endpoint: string;

  constructor(endpoint: string) {
    this.#endpoint = endpoint.replace(/\/$/, "");
  }

  #rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const payload = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    };
    return fetch(this.#endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (res) => {
      const json = await res.json();
      if (json.error) throw new Error(json.error.message ?? "RPC error");
      return json.result as T;
    });
  }

  async latestBlockhash(): Promise<string> {
    const result = await this.#rpcCall<{ blockhash: string; value?: { blockhash: string } }>(
      "getLatestBlockhash",
      [],
    );
    if (result.blockhash) return result.blockhash;
    if (result.value?.blockhash) return result.value.blockhash;
    throw new Error("RPC did not return a blockhash");
  }

  async requestAirdrop(pubkey: PublicKey, lamports: number): Promise<string> {
    return this.#rpcCall("requestAirdrop", [pubkey.toBase58(), lamports]);
  }

  async getAccount(pubkey: PublicKey): Promise<SerializableAccount | null> {
    const result = await this.#rpcCall<{ value: SerializableAccount | null }>(
      "getAccountInfo",
      [pubkey.toBase58()],
    );
    return normalizeAccount(result.value);
  }

  async sendTransaction(
    tx: Transaction | VersionedTransaction,
    options?: SendOptions,
  ): Promise<TransactionResultEnvelope> {
    const signature = await this.#rpcCall<unknown>(
      "sendTransaction",
      [serializeTx(tx), options ?? {}],
    );
    return normalizeSendResult(signature);
  }

  async simulateTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<SimulationResultEnvelope> {
    const result = await this.#rpcCall<unknown>(
      "simulateTransaction",
      [serializeTx(tx)],
    );
    return normalizeSimulationResult(result);
  }
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

export class SolanaLikeClient {
  #transport: ClientTransport;

  constructor(opts: SolanaLikeClientOptions = {}) {
    this.#transport = opts.endpoint
      ? new RpcTransport(opts.endpoint)
      : new LocalTransport(opts.svm);
  }

  static local(): SolanaLikeClient {
    return new SolanaLikeClient();
  }

  static rpc(endpoint: string): SolanaLikeClient {
    return new SolanaLikeClient({ endpoint });
  }

  static fromLiteSvm(svm: LiteSvm): SolanaLikeClient {
    return new SolanaLikeClient({ svm });
  }

  latestBlockhash(): Promise<string> {
    return this.#transport.latestBlockhash();
  }

  requestAirdrop(pubkey: PublicKey, lamports: number | bigint): Promise<string> {
    const amount = typeof lamports === "bigint" ? Number(lamports) : lamports;
    return this.#transport.requestAirdrop(pubkey, amount);
  }

  async getAccount(pubkey: PublicKey): Promise<AccountInfoResponse> {
    const account = await this.#transport.getAccount(pubkey);
    return { address: pubkey, account };
  }

  sendTransaction(
    tx: Transaction | VersionedTransaction,
    options?: SendOptions,
  ): Promise<TransactionResultEnvelope> {
    return this.#transport.sendTransaction(tx, options);
  }

  simulateTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<SimulationResultEnvelope> {
    return this.#transport.simulateTransaction(tx);
  }
}

export function deserializeTransaction(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function decodeBase64Transaction(encoded: string): Uint8Array {
  return deserializeTx(encoded);
}

export function encodeTransaction(tx: Transaction | VersionedTransaction): string {
  return serializeTx(tx);
}
