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
import { SolanaLikeClient, encodeTransaction } from "./client.ts";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLamports(
  client: SolanaLikeClient,
  pubkey: PublicKey,
  lamports: number,
  attempts = 20,
) {
  for (let i = 0; i < attempts; i++) {
    const { account } = await client.getAccount(pubkey);
    if (account?.lamports && account.lamports >= lamports) return account.lamports;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${lamports} lamports`);
}

Deno.test("local client mirrors LiteSVM primitives", async () => {
  const client = SolanaLikeClient.local();
  const payer = await Keypair.generate();
  const recipient = (await Keypair.generate()).publicKey;

  await client.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);

  const blockhash = await client.latestBlockhash();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient,
    lamports: 1_000_000,
  }));
  await tx.sign(payer);

  const result = await client.sendTransaction(tx);
  assertStrictEquals(result.status, "ok");

  const { account } = await client.getAccount(recipient);
  assert(account);
  assertEquals(account.lamports, 1_000_000);
});

Deno.test("in-process fork uses the same client surface", async () => {
  const svm = new LiteSvm();
  const client = SolanaLikeClient.fromLiteSvm(svm);

  const payer = await Keypair.generate();
  const recipient = await Keypair.generate();

  await client.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
  const baseHash = await client.latestBlockhash();

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: baseHash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 250_000,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  await tx.sign([payer]);

  const simulation = await client.simulateTransaction(tx);
  assertEquals(simulation.status, "ok");

  const result = await client.sendTransaction(tx);
  assertEquals(result.status, "ok");

  const { account } = await client.getAccount(recipient.publicKey);
  assert(account);
  assertEquals(account.lamports, 250_000);
});

Deno.test(
  "simulate remotely then execute locally",
  async () => {
    const rpcEndpoint =
      Deno.env.get("SOLANA_RPC_URL") ?? "https://api.devnet.solana.com";

    const rpcClient = SolanaLikeClient.rpc(rpcEndpoint);
    const localClient = SolanaLikeClient.local();

    const payer = await Keypair.generate();
    const recipient = (await Keypair.generate()).publicKey;
    const lamports = 500_000;

    await rpcClient.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
    await waitForLamports(rpcClient, payer.publicKey, LAMPORTS_PER_SOL / 2);

    const remoteMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: await rpcClient.latestBlockhash(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports,
        }),
      ],
    }).compileToV0Message();

    const remoteTx = new VersionedTransaction(remoteMessage);
    await remoteTx.sign([payer]);

    const remoteSimulation = await rpcClient.simulateTransaction(remoteTx);
    assertEquals(remoteSimulation.status, "ok");

    await localClient.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
    const localMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: await localClient.latestBlockhash(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports,
        }),
      ],
    }).compileToV0Message();

    const localTx = new VersionedTransaction(localMessage);
    await localTx.sign([payer]);

    const sendResult = await localClient.sendTransaction(localTx);
    assertEquals(sendResult.status, "ok");

    const { account } = await localClient.getAccount(recipient);
    assert(account);
    assertEquals(account.lamports, lamports);
  },
);

Deno.test("encodeTransaction helpers keep parity across transports", async () => {
  const payer = await Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.unique().toBase58(),
    instructions: [],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  await tx.sign([payer]);

  const encoded = encodeTransaction(tx);
  const roundTripBytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  assertEquals(roundTripBytes, tx.serialize());
});
