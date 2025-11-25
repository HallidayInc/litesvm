import * as bindings from "./bindings/litesvm.ts";

type Handle = bindings.LiteSvmHandle;

export type TransactionResult = bindings.TransactionResultEnvelope;
export type SimulationResult = bindings.SimulationResultEnvelope;
export type SerializableAccount = bindings.SerializableAccount;

function unwrapVoid(result: { error?: string | null }): void {
  if (result.error) {
    throw new Error(result.error);
  }
}

function unwrapValue<T>(result: { value?: T; error?: string | null }): T {
  if (result.error) {
    throw new Error(result.error);
  }

  if (result.value === undefined) {
    throw new Error("LiteSVM binding returned no value");
  }

  return result.value;
}

function unwrapOptionalValue<T>(result: {
  value?: T | null;
  error?: string | null;
}): T | null {
  if (result.error) {
    throw new Error(result.error);
  }

  return result.value ?? null;
}

export interface LiteSvmOptions {
  /**
   * Start with an empty LiteSVM without default programs or sysvars.
   * Useful for fine-grained control when bootstrapping.
   */
  basic?: boolean;
}

export class LiteSvm {
  #handle: Handle;

  constructor(opts: LiteSvmOptions = {}) {
    this.#handle = opts.basic ? bindings.create_basic() : bindings.create_default();
  }

  dispose(): void {
    bindings.dispose(this.#handle);
  }

  latestBlockhash(): Uint8Array {
    return unwrapValue(bindings.latest_blockhash(this.#handle));
  }

  latestBlockhashString(): string {
    return unwrapValue(bindings.latest_blockhash_string(this.#handle));
  }

  expireBlockhash(): void {
    unwrapVoid(bindings.expire_blockhash(this.#handle));
  }

  setDefaultPrograms(): void {
    unwrapVoid(bindings.set_default_programs(this.#handle));
  }

  setPrecompiles(): void {
    unwrapVoid(bindings.set_precompiles(this.#handle));
  }

  setBuiltins(): void {
    unwrapVoid(bindings.set_builtins(this.#handle));
  }

  setSysvars(): void {
    unwrapVoid(bindings.set_sysvars(this.#handle));
  }

  airdrop(pubkey: Uint8Array, lamports: bigint | number): void {
    const value = typeof lamports === "bigint" ? Number(lamports) : lamports;
    unwrapVoid(bindings.airdrop(this.#handle, pubkey, value));
  }

  getAccount(pubkey: Uint8Array): SerializableAccount | null {
    return unwrapOptionalValue(bindings.get_account(this.#handle, pubkey));
  }

  setAccount(pubkey: Uint8Array, account: SerializableAccount): void {
    unwrapVoid(bindings.set_account(this.#handle, pubkey, account));
  }

  addProgram(programId: Uint8Array, programBytes: Uint8Array): void {
    unwrapVoid(bindings.add_program(this.#handle, programId, programBytes));
  }

  sendLegacyTransaction(bytes: Uint8Array): TransactionResult {
    return unwrapValue(bindings.send_legacy_transaction(this.#handle, bytes));
  }

  sendVersionedTransaction(bytes: Uint8Array): TransactionResult {
    return unwrapValue(bindings.send_versioned_transaction(this.#handle, bytes));
  }

  simulateLegacyTransaction(bytes: Uint8Array): SimulationResult {
    return unwrapValue(bindings.simulate_legacy_transaction(this.#handle, bytes));
  }

  simulateVersionedTransaction(bytes: Uint8Array): SimulationResult {
    return unwrapValue(bindings.simulate_versioned_transaction(this.#handle, bytes));
  }

  setTransactionHistory(capacity: number): void {
    unwrapVoid(bindings.set_transaction_history(this.#handle, capacity));
  }

  minimumBalanceForRentExemption(dataLength: number): number {
    return Number(
      unwrapValue(bindings.minimum_balance_for_rent_exemption(this.#handle, dataLength)),
    );
  }
}

export const createBasic = bindings.create_basic;
export const createDefault = bindings.create_default;
