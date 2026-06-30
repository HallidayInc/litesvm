import {
    AddressLookupTableProgram,
    InstructionInput,
    MessageV0,
    PublicKey,
    SolanaSigner,
    VersionedTransaction,
} from "../solana.ts";
import type { Client } from "./types.ts";

/**
 * Create an Address Lookup Table on-chain and populate it with `addresses`,
 * via real CreateLookupTable + ExtendLookupTable instructions (works against
 * both litesvm and a real cluster). The payer is the table authority. Returns
 * the table address. Extend is chunked so each tx stays under the wire limit.
 *
 * Note: on a real cluster an ALT is only usable one slot after it is extended;
 * `SolChain.simulateAndSend` warps litesvm past that slot when given the ALT.
 */
export async function createAddressLookupTable(
    client: Client,
    payer: SolanaSigner,
    addresses: PublicKey[],
    opts?: { extendChunkSize?: number },
): Promise<PublicKey> {
    const payerPk = payer.getPublicKey();
    const recentSlot = await client.getSlot("finalized");
    const { instruction: createIx, lookupTableAddress } =
        await AddressLookupTableProgram
            .createLookupTable({
                authority: payerPk,
                payer: payerPk,
                recentSlot,
            });

    const send = async (ixs: InstructionInput[], label: string) => {
        const blockhash = await client.latestBlockhash();
        const msg = MessageV0.fromInstructions({
            payerKey: payerPk,
            recentBlockhash: blockhash,
            instructions: ixs,
        });
        const tx = new VersionedTransaction(msg);
        await tx.sign([payer]);
        const res = await client.sendTransaction(tx);
        if (res.meta?.err) {
            throw new Error(`${label} failed: ${JSON.stringify(res.meta.err)}`);
        }
    };

    await send([createIx], "createLookupTable");

    // Keep each extend under the 1232-byte tx limit: 32 bytes/address + ~150
    // bytes overhead → 20 addresses is a safe chunk.
    const chunk = opts?.extendChunkSize ?? 20;
    for (let i = 0; i < addresses.length; i += chunk) {
        const slice = addresses.slice(i, i + chunk);
        const extendIx = AddressLookupTableProgram.extendLookupTable({
            lookupTable: lookupTableAddress,
            authority: payerPk,
            payer: payerPk,
            addresses: slice,
        });
        await send([extendIx], `extendLookupTable[${i}]`);
    }
    return lookupTableAddress;
}
