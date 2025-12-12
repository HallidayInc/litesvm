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
} from "npm:@solana/web3.js";
import bs58 from "npm:bs58";

export interface SolanaLikeClientOptions {
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

function isVersioned(tx: Transaction | VersionedTransaction): tx is VersionedTransaction {
  return "version" in tx;
}

class LocalTransport implements ClientTransport {
  #svm: LiteSvm;

  constructor() {
    this.#svm = new LiteSvm();
  }

  async latestBlockhash(): Promise<string> {
    return this.#svm.latestBlockhashString();
  }

  async requestAirdrop(pubkey: PublicKey, lamports: number): Promise<string> {
    this.#svm.airdrop(pubkey.toBytes(), lamports);
    const rand = crypto.getRandomValues(new Uint8Array(64));
    return bs58.encode(rand);
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
    return result.value;
  }

  async sendTransaction(
    tx: Transaction | VersionedTransaction,
    options?: SendOptions,
  ): Promise<TransactionResultEnvelope> {
    const signature = await this.#rpcCall<TransactionResultEnvelope>(
      "sendTransaction",
      [serializeTx(tx), options ?? {}],
    );
    return signature;
  }

  async simulateTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<SimulationResultEnvelope> {
    return this.#rpcCall(
      "simulateTransaction",
      [serializeTx(tx)],
    );
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
      : new LocalTransport();
  }

  static local(): SolanaLikeClient {
    return new SolanaLikeClient();
  }

  static rpc(endpoint: string): SolanaLikeClient {
    return new SolanaLikeClient({ endpoint });
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

export function deserializeTransaction(bytes: Uint8Array): Transaction | VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch (_) {
    return Transaction.from(bytes);
  }
}

export function decodeBase64Transaction(encoded: string): Transaction | VersionedTransaction {
  return deserializeTransaction(deserializeTx(encoded));
}

export function encodeTransaction(tx: Transaction | VersionedTransaction): string {
  return serializeTx(tx);
}
