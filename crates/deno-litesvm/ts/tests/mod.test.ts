import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import {
    Keypair,
    LAMPORTS_PER_SOL,
    MessageV0,
    PublicKey,
    SystemProgram,
    Transaction,
    VersionedTransaction,
} from "../src/solana.ts";
import { LiteSvm } from "../src/mod.ts";

Deno.test("executes a legacy transfer transaction", async () => {
    const svm = new LiteSvm();
    const payer = await Keypair.generate();
    const recipient = PublicKey.unique();

    svm.airdrop(payer.publicKey.toBytes(), LAMPORTS_PER_SOL);

    const blockhash = svm.latestBlockhashString();
    const tx = new Transaction(payer.publicKey, blockhash);
    tx.add(
        SystemProgram.transfer(payer.publicKey, recipient, 1_000_000n),
    );
    await tx.sign(payer);

    const result = svm.sendLegacyTransaction(tx.serialize());
    assertStrictEquals(result.status, "ok");

    const account = svm.getAccount(recipient.toBytes());
    assert(account);
    assertStrictEquals(BigInt(account.lamports), 1_000_000n);
});

Deno.test("executes a versioned transaction", async () => {
    const svm = new LiteSvm();
    const payer = await Keypair.generate();
    const recipient = PublicKey.unique();

    svm.airdrop(payer.publicKey.toBytes(), 5 * LAMPORTS_PER_SOL);
    const blockhash = svm.latestBlockhashString();

    const message = MessageV0.fromInstructions({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            SystemProgram.transfer(payer.publicKey, recipient, 2_000_000n),
        ],
    });

    const tx = new VersionedTransaction(message);
    await tx.sign([payer]);

    const result = svm.sendVersionedTransaction(tx.serialize());
    assertStrictEquals(result.status, "ok");
    assert(result.status === "ok");
    assert(result.logs.length > 0);
});
