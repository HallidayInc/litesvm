import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "./solana.ts";
import { LiteSvm } from "./mod.ts";

function checksumForLength(length: number): number {
  let acc = 0;
  for (let index = 0; index < length; index++) {
    acc = (acc + ((index + 1) & 0xff)) & 0xff;
  }
  return acc;
}

Deno.test("executes a program that uses realloc and clock syscalls", async () => {
  const svm = new LiteSvm();
  const payer = await Keypair.generate();
  const programId = PublicKey.unique();
  const dataAccount = PublicKey.unique();
  const programBytes = await Deno.readFile(
    new URL(
      "../litesvm/test_programs/target/deploy/realloc_clock.so",
      import.meta.url,
    ),
  );

  svm.addProgram(programId.toBytes(), programBytes);

  const dataLen = 64;
  svm.setAccount(dataAccount.toBytes(), {
    lamports: 1_000_000,
    data: new Uint8Array(dataLen),
    owner: programId.toBytes(),
    executable: false,
    rent_epoch: 0,
  });

  svm.airdrop(payer.publicKey.toBytes(), LAMPORTS_PER_SOL);

  const instructionData = new Uint8Array(4);
  new DataView(instructionData.buffer).setUint32(0, 32, true);

  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: svm.latestBlockhashString(),
  });
  tx.add({
    programId,
    keys: [{ pubkey: dataAccount, isSigner: false, isWritable: true }],
    data: instructionData,
  });
  await tx.sign(payer);

  const result = svm.sendLegacyTransaction(tx.serialize());
  assertStrictEquals(result.status, "ok");

  const updated = svm.getAccount(dataAccount.toBytes());
  assert(updated);
  assertStrictEquals(updated.data.length, dataLen);

  const view = new DataView(
    updated.data.buffer,
    updated.data.byteOffset,
    updated.data.byteLength,
  );
  assertEquals(updated.data[0], checksumForLength(32));
  assertEquals(view.getBigInt64(1, true), 0n);
  assertEquals(view.getBigUint64(9, true), 0n);
});
