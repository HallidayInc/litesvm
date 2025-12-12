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
import bs58 from "npm:bs58";
import {
  LiteSvm,
  SimulationResultEnvelope,
  TransactionResultEnvelope,
} from "./mod.ts";
import { SolanaLikeClient, encodeTransaction } from "./client.ts";

function startLiteSvmRpcServer(port = 0) {
  const svm = new LiteSvm();
  const controller = new AbortController();

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port,
    signal: controller.signal,
  }, async (req) => {
    const { method, params, id } = await req.json();

    const respond = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" },
      });

    const error = (message: string) =>
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });

    try {
      switch (method) {
        case "getLatestBlockhash":
          return respond({
            blockhash: svm.latestBlockhashString(),
            lastValidBlockHeight: 0,
          });
        case "requestAirdrop": {
          const [pubkey, lamports] = params as [string, number];
          svm.airdrop(new PublicKey(pubkey).toBytes(), lamports);
          const signature = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
          return respond(signature);
        }
        case "getAccountInfo": {
          const [pubkey] = params as [string];
          const account = svm.getAccount(new PublicKey(pubkey).toBytes());
          return respond({ value: account });
        }
        case "sendTransaction": {
          const [encoded] = params as [string];
          const txBytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
          const result = svm.sendVersionedTransaction(txBytes) as TransactionResultEnvelope;
          return respond(result);
        }
        case "simulateTransaction": {
          const [encoded] = params as [string];
          const txBytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
          const result = svm.simulateVersionedTransaction(txBytes) as SimulationResultEnvelope;
          return respond(result);
        }
        default:
          return error(`Unsupported method ${method}`);
      }
    } catch (err) {
      return error((err as Error).message);
    }
  });

  const { port: boundPort } = server.addr as Deno.NetAddr;
  const url = `http://127.0.0.1:${boundPort}`;

  const close = () => controller.abort();
  return { url, close };
}

Deno.test("local client mirrors LiteSVM primitives", async () => {
  const client = SolanaLikeClient.local();
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;

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
  tx.sign(payer);

  const result = await client.sendTransaction(tx);
  assert.strictEqual(result.status, "ok");

  const { account } = await client.getAccount(recipient);
  assert.ok(account);
  assert.equal(account.lamports, 1_000_000);
});

Deno.test("rpc client talks to LiteSVM-backed JSON-RPC", async () => {
  const server = startLiteSvmRpcServer();
  const client = SolanaLikeClient.rpc(server.url);

  const payer = Keypair.generate();
  await client.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: await client.latestBlockhash(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: PublicKey.unique(),
        lamports: 750_000,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const sendResult = await client.sendTransaction(tx);
  assert.equal(sendResult.status, "ok");

  const simulation = await client.simulateTransaction(tx);
  assert.equal(simulation.status, "ok");

  server.close();
});

Deno.test("encodeTransaction helpers keep parity across transports", () => {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.unique().toBase58(),
    instructions: [],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const encoded = encodeTransaction(tx);
  const roundTripBytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  assert.deepEqual(roundTripBytes, tx.serialize());
});
