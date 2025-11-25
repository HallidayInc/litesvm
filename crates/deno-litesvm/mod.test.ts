import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "./solana.ts";
import { LiteSvm } from "./mod.ts";

Deno.test("executes a legacy transfer transaction", async () => {
  const svm = new LiteSvm();
  const payer = await Keypair.generate();
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
  await tx.sign(payer);

  const result = svm.sendLegacyTransaction(tx.serialize());
  assertStrictEquals(result.status, "ok");

  const account = svm.getAccount(recipient.toBytes());
  assert(account);
  assertStrictEquals(BigInt(account.lamports), 1_000_000n);
});

Deno.test("simulates a versioned transaction without committing state", async () => {
  const svm = new LiteSvm();
  const payer = await Keypair.generate();
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
  await tx.sign([payer]);

  const result = svm.simulateVersionedTransaction(tx.serialize());
  assertStrictEquals(result.status, "ok");
  const logs = Array.isArray((result.value as { logs?: unknown[] }).logs)
    ? (result.value as { logs: unknown[] }).logs
    : [];
  assert(logs.length > 0);

  // Simulation should not mutate accounts
  const account = svm.getAccount(recipient.toBytes());
  assertStrictEquals(account, null);
});
