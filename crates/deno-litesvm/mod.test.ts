import assert from "node:assert/strict";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "npm:@solana/web3.js";
import { LiteSvm } from "./mod.ts";

Deno.test("executes a legacy transfer transaction", () => {
  const svm = new LiteSvm();
  const payer = Keypair.generate();
  const recipient = PublicKey.unique();

  svm.airdrop(payer.publicKey.toBytes(), LAMPORTS_PER_SOL);

  const blockhash = svm.latestBlockhashString();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 1_000_000n,
    }),
  );
  tx.sign(payer);

  const result = svm.sendLegacyTransaction(tx.serialize());
  assert.strictEqual(result.status, "ok");

  const account = svm.getAccount(recipient.toBytes());
  assert.ok(account);
  assert.strictEqual(BigInt(account.lamports), 1_000_000n);
});

Deno.test("simulates a versioned transaction without committing state", () => {
  const svm = new LiteSvm();
  const payer = Keypair.generate();
  const recipient = PublicKey.unique();

  svm.airdrop(payer.publicKey.toBytes(), 5 * LAMPORTS_PER_SOL);
  const blockhash = svm.latestBlockhashString();

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: 2_000_000n,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const result = svm.simulateVersionedTransaction(tx.serialize());
  assert.strictEqual(result.status, "ok");
  assert.ok(result.value.logs.length > 0);

  // Simulation should not mutate accounts
  const account = svm.getAccount(recipient.toBytes());
  assert.strictEqual(account, null);
});
