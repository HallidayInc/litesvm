import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert";
import {
    ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    AssociatedTokenProgram,
    buildAltAccountData,
    createTokenAccountData,
    getSPLAssociatedTokenAddress,
    type InstructionInput,
    Keypair,
    KNOWN_MINTS,
    LAMPORTS_PER_SOL,
    MessageV0,
    MINT_ACCOUNT_SIZE,
    parseAltAccount,
    parseTokenAccountData,
    PublicKey,
    SystemProgram,
    TOKEN_2022_PROGRAM_PUBKEY,
    TOKEN_PROGRAM_PUBKEY,
    TokenProgram,
    Transaction,
    VersionedTransaction,
} from "../src/solana.ts";
import { LocalClient, RpcClient } from "../src/client.ts";
import {
    altKeysFromIxs,
    altKeysFromTx,
} from "../src/client/utils.ts";

const DEFAULT_RPC = Deno.env.get("SOLANA_RPC_URL") ??
    "https://api.devnet.solana.com";

function makeInstructionWithKeys(
    programId: PublicKey,
    payer: PublicKey,
    extraKeys: PublicKey[],
): InstructionInput {
    return {
        programId,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            ...extraKeys.map((pk) => ({
                pubkey: pk,
                isSigner: false,
                isWritable: false,
            })),
        ],
        data: new Uint8Array(),
    };
}

async function buildVersionedTx(
    client: LocalClient,
    payer: Keypair,
    instructions: InstructionInput[],
    altLookupsResolved: { accountKey: PublicKey; addresses: PublicKey[] }[] = [],
): Promise<VersionedTransaction> {
    const msg = MessageV0.fromInstructionsWithAlts({
        payerKey: payer.publicKey,
        recentBlockhash: await client.latestBlockhash(),
        instructions,
        altLookupsResolved,
    });
    const tx = new VersionedTransaction(msg);
    await tx.sign([payer]);
    return tx;
}

function plantLookupTable(
    client: LocalClient,
    lookupTable: PublicKey,
    addresses: PublicKey[],
    authority: PublicKey,
    lastExtendedSlot: number | bigint,
): void {
    client.svm.setAccount(lookupTable.toBytes(), {
        lamports: 1_000_000_000,
        data: buildAltAccountData(addresses, authority, lastExtendedSlot),
        owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID.toBytes(),
        executable: false,
        rent_epoch: 0,
    });
}

Deno.test("fork client mirrors LiteSVM primitives", async () => {
    const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const payer = await Keypair.generate();
    const recipient = (await Keypair.generate()).publicKey;

    await client.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);

    const blockhash = await client.latestBlockhash();
    const tx = new Transaction(payer.publicKey, blockhash).add(
        SystemProgram.transfer(payer.publicKey, recipient, 1_000_000),
    );
    await tx.sign(payer);

    const result = await client.sendTransaction(tx);
    assertEquals(result.meta?.err, null);

    const account = await client.getAccount(recipient);
    assert(account);
    assertEquals(account.lamports, 1_000_000);
});

Deno.test("serializeBase64 roundtrips correctly", async () => {
    const payer = await Keypair.generate();
    const message = MessageV0.fromInstructions({
        payerKey: payer.publicKey,
        recentBlockhash: PublicKey.unique().toBase58(),
        instructions: [],
    });
    const tx = new VersionedTransaction(message);
    await tx.sign([payer]);

    const encoded = tx.serializeBase64();
    const round_trip_bytes = Uint8Array.from(
        atob(encoded),
        (c: string) => c.charCodeAt(0),
    );
    assertEquals(round_trip_bytes, tx.serialize());
});

Deno.test(
    "fork transport: SPL token transfer between accounts",
    { ignore: !Deno.env.get("SOLANA_RPC_URL") },
    async () => {
        const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;

        // Create a forked client that fetches accounts from mainnet/devnet
        const client = new LocalClient({ rpcEndpoint });
        const svm = client.svm;

        // Generate test keypairs
        const mintAuthority = await Keypair.generate();
        const sender = await Keypair.generate();
        const recipient = await Keypair.generate();

        // Mint account (will be created fresh)
        const mintKeypair = await Keypair.generate();
        const mint = mintKeypair.publicKey;

        // Fund accounts with SOL for rent
        await client.requestAirdrop(mintAuthority.publicKey, 10 * LAMPORTS_PER_SOL);
        await client.requestAirdrop(sender.publicKey, 10 * LAMPORTS_PER_SOL);
        await client.requestAirdrop(recipient.publicKey, LAMPORTS_PER_SOL);

        // Get associated token addresses
        const senderAta = await getSPLAssociatedTokenAddress(
            mint,
            sender.publicKey,
        );
        const recipientAta = await getSPLAssociatedTokenAddress(
            mint,
            recipient.publicKey,
        );

        // Step 1: Create the mint account
        const MINT_SIZE = 82; // Size of a mint account
        const mintRent = 1_461_600; // Rent exemption for mint (~0.00146 SOL)

        const createMintTx = new Transaction(
            mintAuthority.publicKey,
            await client.latestBlockhash(),
        ).add(
            // Create account for mint
            {
                programId: SystemProgram.programId,
                keys: [
                    { pubkey: mintAuthority.publicKey, isSigner: true, isWritable: true },
                    { pubkey: mint, isSigner: true, isWritable: true },
                ],
                data: (() => {
                    // CreateAccount instruction: index 0, lamports (8 bytes), space (8 bytes), owner (32 bytes)
                    const data = new Uint8Array(4 + 8 + 8 + 32);
                    const view = new DataView(data.buffer);
                    view.setUint32(0, 0, true); // instruction index
                    view.setBigUint64(4, BigInt(mintRent), true); // lamports
                    view.setBigUint64(12, BigInt(MINT_SIZE), true); // space
                    data.set(TokenProgram.programId.toBytes(), 20); // owner
                    return data;
                })(),
            },
            // Initialize mint
            TokenProgram.initializeMint({
                mint,
                decimals: 9,
                mintAuthority: mintAuthority.publicKey,
                freezeAuthority: null,
            }),
        );
        await createMintTx.sign(mintAuthority, mintKeypair);

        const createMintResult = await client.sendTransaction(createMintTx);
        assertEquals(createMintResult.meta?.err, null, "Failed to create mint");

        // Step 2: Create sender's associated token account and mint tokens
        const TOKEN_ACCOUNT_SIZE = 165;
        const tokenAccountRent = 2_039_280;

        const createSenderAtaTx = new Transaction(
            sender.publicKey,
            await client.latestBlockhash(),
        ).add(
            AssociatedTokenProgram.create(
                sender.publicKey,
                senderAta,
                sender.publicKey,
                mint,
            ),
        );
        await createSenderAtaTx.sign(sender);

        const createSenderAtaResult = await client.sendTransaction(
            createSenderAtaTx,
        );
        assertEquals(
            createSenderAtaResult.meta?.err,
            null,
            "Failed to create sender ATA",
        );

        // Step 3: Mint tokens to sender
        const mintAmount = BigInt(1_000_000_000); // 1 token with 9 decimals

        const mintToTx = new Transaction(
            mintAuthority.publicKey,
            await client.latestBlockhash(),
        ).add(
            TokenProgram.mintTo(mint, senderAta, mintAuthority.publicKey, mintAmount),
        );
        await mintToTx.sign(mintAuthority);

        const mintToResult = await client.sendTransaction(mintToTx);
        assertEquals(mintToResult.meta?.err, null, "Failed to mint tokens");

        // Step 4: Create recipient's associated token account
        const createRecipientAtaTx = new Transaction(
            sender.publicKey,
            await client.latestBlockhash(),
        ).add(
            AssociatedTokenProgram.create(
                sender.publicKey,
                recipientAta,
                recipient.publicKey,
                mint,
            ),
        );
        await createRecipientAtaTx.sign(sender);

        const createRecipientAtaResult = await client.sendTransaction(
            createRecipientAtaTx,
        );
        assertEquals(
            createRecipientAtaResult.meta?.err,
            null,
            "Failed to create recipient ATA",
        );

        // Step 5: Transfer tokens from sender to recipient
        const transferAmount = BigInt(500_000_000); // 0.5 tokens

        const transferTx = new Transaction(
            sender.publicKey,
            await client.latestBlockhash(),
        ).add(
            TokenProgram.transfer(
                senderAta,
                recipientAta,
                sender.publicKey,
                transferAmount,
            ),
        );
        await transferTx.sign(sender);

        const transferResult = await client.sendTransaction(transferTx);
        assertEquals(transferResult.meta?.err, null, "Failed to transfer tokens");

        // Verify balances
        const senderAtaAccount = await client.getAccount(senderAta);
        const recipientAtaAccount = await client.getAccount(recipientAta);

        assert(senderAtaAccount, "Sender ATA should exist");
        assert(recipientAtaAccount, "Recipient ATA should exist");

        // Parse token account data to get balances
        // Token account structure: mint (32) + owner (32) + amount (8) + ...
        const senderBalance = new DataView(senderAtaAccount.data.buffer)
            .getBigUint64(64, true);
        const recipientBalance = new DataView(recipientAtaAccount.data.buffer)
            .getBigUint64(64, true);

        assertEquals(
            senderBalance,
            mintAmount - transferAmount,
            "Sender should have 0.5 tokens remaining",
        );
        assertEquals(
            recipientBalance,
            transferAmount,
            "Recipient should have 0.5 tokens",
        );

        console.log(`SPL Token transfer successful!`);
        console.log(
            `  Sender balance: ${senderBalance} (${Number(senderBalance) / 1e9} tokens)`,
        );
        console.log(
            `  Recipient balance: ${recipientBalance} (${Number(recipientBalance) / 1e9} tokens)`,
        );
    },
);

Deno.test(
    "hijack mainnet USDC and transfer between accounts",
    { ignore: !Deno.env.get("SOLANA_RPC_URL") },
    async () => {
        const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;

        // Create a forked client - this will fetch the Token Program from mainnet
        const client = new LocalClient({ rpcEndpoint });
        const svm = client.svm;

        // Use mainnet USDC mint
        const usdcMint = KNOWN_MINTS.USDC_MAINNET;

        // Generate test wallets
        const sender = await Keypair.generate();
        const recipient = await Keypair.generate();

        // Fund with SOL for transaction fees
        await client.requestAirdrop(sender.publicKey, 10 * LAMPORTS_PER_SOL);
        await client.requestAirdrop(recipient.publicKey, LAMPORTS_PER_SOL);

        // Derive ATAs for USDC
        const senderAta = await getSPLAssociatedTokenAddress(
            usdcMint,
            sender.publicKey,
        );
        const recipientAta = await getSPLAssociatedTokenAddress(
            usdcMint,
            recipient.publicKey,
        );

        // HIJACK: Set sender's USDC balance to 1000 USDC (USDC has 6 decimals)
        const initialUsdcAmount = BigInt(1000_000_000); // 1000 USDC
        client.setSPLTokenBalance(
            senderAta,
            usdcMint,
            sender.publicKey,
            initialUsdcAmount,
        );

        // Also create recipient's token account with 0 balance
        client.setSPLTokenBalance(
            recipientAta,
            usdcMint,
            recipient.publicKey,
            BigInt(0),
        );

        // Verify the hijacked balance
        const hijackedBalanceResult = await client.getTokenBalance(
            usdcMint,
            sender.publicKey,
        );
        assertEquals(
            BigInt(hijackedBalanceResult.amount),
            initialUsdcAmount,
            "Hijacked balance should be 1000 USDC",
        );

        console.log(
            `Hijacked USDC balance: ${Number(hijackedBalanceResult.amount) / 1e6} USDC`,
        );

        // Now transfer 250 USDC from sender to recipient
        const transferAmount = BigInt(250_000_000); // 250 USDC

        const transferTx = new Transaction(
            sender.publicKey,
            await client.latestBlockhash(),
        ).add(
            TokenProgram.transfer(
                senderAta,
                recipientAta,
                sender.publicKey,
                transferAmount,
            ),
        );
        await transferTx.sign(sender);

        const transferResult = await client.sendTransaction(transferTx);
        assertEquals(
            transferResult.meta?.err,
            null,
            "USDC transfer should succeed",
        );

        // Verify final balances
        const senderFinalBalanceResult = await client.getTokenBalance(
            usdcMint,
            sender.publicKey,
        );
        const recipientFinalBalanceResult = await client.getTokenBalance(
            usdcMint,
            recipient.publicKey,
        );
        const senderFinalBalance = BigInt(senderFinalBalanceResult.amount);
        const recipientFinalBalance = BigInt(recipientFinalBalanceResult.amount);

        assertEquals(
            senderFinalBalance,
            initialUsdcAmount - transferAmount,
            "Sender should have 750 USDC",
        );
        assertEquals(
            recipientFinalBalance,
            transferAmount,
            "Recipient should have 250 USDC",
        );

        console.log(`\nUSDC Transfer successful!`);
        console.log(
            `  Sender USDC balance: ${Number(senderFinalBalance) / 1e6} USDC`,
        );
        console.log(
            `  Recipient USDC balance: ${Number(recipientFinalBalance) / 1e6} USDC`,
        );
    },
);

Deno.test(
    "hijack real mainnet USDC holder and transfer their tokens",
    { ignore: !Deno.env.get("SOLANA_RPC_URL")?.includes("mainnet") },
    async () => {
        const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;

        // Create a forked client from mainnet
        const client = new LocalClient({ rpcEndpoint });
        const svm = client.svm;

        const impersonator = await Keypair.generate();
        await client.requestAirdrop(impersonator.publicKey, LAMPORTS_PER_SOL);

        // Use a known USDC holder with standard token account format (165 bytes)
        // This is Coinbase's USDC custody wallet ATA
        const knownUsdcHolder = new PublicKey(
            "FHKqMXmWjwTebBfnqPEUBnK4SsuBqN3YieMc3p9gBVY1",
        );

        // Fetch the real USDC account from mainnet
        const holderAccount = await client.getAccount(knownUsdcHolder);

        // If account doesn't exist or is wrong size, use synthetic approach
        if (!holderAccount || holderAccount.data.length !== 165) {
            console.log(
                `Account not found or wrong size (${holderAccount?.data.length ?? 0} bytes)`,
            );
            console.log("Using synthetic approach for mainnet USDC heist...\n");

            // Use synthetic approach - create our own token account with USDC balance
            const usdcMint = KNOWN_MINTS.USDC_MAINNET;

            // Fetch the USDC mint first
            const mintAccount = await client.getAccount(usdcMint);
            if (!mintAccount) {
                console.log("Could not fetch USDC mint - skipping test");
                return;
            }

            // Create recipient (impersonator hoisted above)
            const recipient = await Keypair.generate();
            await client.requestAirdrop(recipient.publicKey, LAMPORTS_PER_SOL);

            // Create ATAs
            const impersonatorAta = await getSPLAssociatedTokenAddress(
                usdcMint,
                impersonator.publicKey,
            );
            const recipientAta = await getSPLAssociatedTokenAddress(
                usdcMint,
                recipient.publicKey,
            );

            // Hijack: Give impersonator 10 million USDC
            const hijackedAmount = BigInt(10_000_000_000_000); // 10M USDC (6 decimals)
            client.setSPLTokenBalance(
                impersonatorAta,
                usdcMint,
                impersonator.publicKey,
                hijackedAmount,
            );

            // Set up recipient ATA with 0 balance
            client.setSPLTokenBalance(
                recipientAta,
                usdcMint,
                recipient.publicKey,
                BigInt(0),
            );

            console.log(
                `Hijacked ${Number(hijackedAmount) / 1e6} USDC into impersonator's account`,
            );

            // Transfer 1M USDC
            const transferAmount = BigInt(1_000_000_000_000); // 1M USDC

            const transferTx = new Transaction(
                impersonator.publicKey,
                await client.latestBlockhash(),
            ).add(
                TokenProgram.transfer(
                    impersonatorAta,
                    recipientAta,
                    impersonator.publicKey,
                    transferAmount,
                ),
            );
            await transferTx.sign(impersonator);

            const transferResult = await client.sendTransaction(transferTx);
            assertEquals(
                transferResult.meta?.err,
                null,
                "Hijacked USDC transfer should succeed",
            );

            // Verify
            const finalBalanceResult = await client.getTokenBalance(
                usdcMint,
                recipient.publicKey,
            );
            assertEquals(BigInt(finalBalanceResult.amount), transferAmount);

            console.log(`\n🏴‍☠️ Synthetic USDC Heist successful!`);
            console.log(`  Transferred ${Number(transferAmount) / 1e6} USDC`);
            console.log(
                `  Recipient now has: ${Number(finalBalanceResult.amount) / 1e6} USDC`,
            );
            return;
        }

        // Real mainnet holder found! Parse and hijack
        const parsedHolder = parseTokenAccountData(holderAccount.data);
        const realBalance = parsedHolder.amount;

        console.log(
            `\nReal USDC holder balance: ${Number(realBalance) / 1e6} USDC`,
        );

        // Generate a recipient wallet
        const recipient = await Keypair.generate();
        await client.requestAirdrop(recipient.publicKey, LAMPORTS_PER_SOL);

        // Create recipient's USDC ATA
        const usdcMint = KNOWN_MINTS.USDC_MAINNET;
        const recipientAta = await getSPLAssociatedTokenAddress(
            usdcMint,
            recipient.publicKey,
        );

        // Ensure the USDC mint account exists
        const mintAccount = await client.getAccount(usdcMint);
        if (!mintAccount) {
            console.log("Could not fetch USDC mint - skipping test");
            return;
        }

        client.setSPLTokenBalance(
            recipientAta,
            usdcMint,
            recipient.publicKey,
            BigInt(0),
        );

        const modifiedData = new Uint8Array(holderAccount.data);
        modifiedData.set(impersonator.publicKey.toBytes(), 32); // Set owner at offset 32

        svm.setAccount(knownUsdcHolder.toBytes(), {
            ...holderAccount,
            data: modifiedData,
        });

        // Transfer half the balance or 1M USDC, whichever is smaller
        const transferAmount = realBalance < BigInt(2_000_000_000_000)
            ? realBalance / BigInt(2)
            : BigInt(1_000_000_000_000);

        if (transferAmount === BigInt(0)) {
            console.log("Account has 0 balance, skipping transfer test");
            return;
        }

        const transferTx = new Transaction(
            impersonator.publicKey,
            await client.latestBlockhash(),
        ).add(
            TokenProgram.transfer(
                knownUsdcHolder,
                recipientAta,
                impersonator.publicKey,
                transferAmount,
            ),
        );
        await transferTx.sign(impersonator);

        const transferResult = await client.sendTransaction(transferTx);
        if (transferResult.meta?.err) {
            console.log("Transfer error:", transferResult.meta.err);
            console.log("Logs:", transferResult.meta.logMessages);
        }
        assertEquals(
            transferResult.meta?.err,
            null,
            "Hijacked USDC transfer should succeed",
        );

        const recipientFinalBalanceResult = await client.getTokenBalance(
            usdcMint,
            recipient.publicKey,
        );
        assertEquals(BigInt(recipientFinalBalanceResult.amount), transferAmount);

        console.log(`\n🏴‍☠️ Real USDC Heist successful!`);
        console.log(
            `  Stole ${Number(transferAmount) / 1e6} USDC from real mainnet holder`,
        );
        console.log(
            `  Recipient now has: ${Number(recipientFinalBalanceResult.amount) / 1e6} USDC`,
        );
    },
);

Deno.test("svm.setTokenBalance and svm.modifyTokenBalance work correctly", async () => {
    const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const svm = client.svm;

    const owner = await Keypair.generate();
    const mint = (await Keypair.generate()).publicKey;
    const tokenAccount = await getSPLAssociatedTokenAddress(mint, owner.publicKey);

    // Set initial balance
    client.setSPLTokenBalance(tokenAccount, mint, owner.publicKey, BigInt(1000));

    // Parse and verify structure
    const account = svm.getAccount(tokenAccount.toBytes())!;
    const parsed = parseTokenAccountData(account.data);
    assertEquals(parsed.amount, BigInt(1000));
    assertEquals(parsed.state, 1); // Initialized
    assertEquals(new PublicKey(parsed.mint).toBase58(), mint.toBase58());
    assertEquals(
        new PublicKey(parsed.owner).toBase58(),
        owner.publicKey.toBase58(),
    );

    // Set a new balance
    client.setSPLTokenBalance(tokenAccount, mint, owner.publicKey, BigInt(5000));

    // Verify other fields unchanged
    const modifiedAccount = svm.getAccount(tokenAccount.toBytes())!;
    const modifiedParsed = parseTokenAccountData(modifiedAccount.data);
    assertEquals(new PublicKey(modifiedParsed.mint).toBase58(), mint.toBase58());
    assertEquals(
        new PublicKey(modifiedParsed.owner).toBase58(),
        owner.publicKey.toBase58(),
    );

    console.log("Token balance utilities work correctly!");
});

Deno.test("fork client: getBalance", async () => {
    const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const payer = await Keypair.generate();

    // Balance should be 0 before airdrop
    let balance = await client.getNativeBalance(payer.publicKey);
    assertEquals(balance, 0);

    // Airdrop and check balance
    await client.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL);
    balance = await client.getNativeBalance(payer.publicKey);
    assertEquals(balance, 5 * LAMPORTS_PER_SOL);

    console.log(`Local RPC methods work: balance=${balance}`);
});

Deno.test("fork client: getTokenAccountBalance via transport", async () => {
    const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const svm = client.svm;

    const owner = await Keypair.generate();
    const mint = (await Keypair.generate()).publicKey;
    const tokenAccount = await getSPLAssociatedTokenAddress(mint, owner.publicKey);

    // Set up a token account with a known balance
    client.setSPLTokenBalance(
        tokenAccount,
        mint,
        owner.publicKey,
        BigInt(42_000_000),
    );

    // getTokenAccountBalance should return the balance through the client
    const tokenBalance = await client.getTokenBalance(
        mint,
        owner.publicKey,
    );
    assertEquals(tokenBalance.amount, "42000000");
    assertEquals(tokenBalance.uiAmountString, "42000000");

    console.log(`getTokenAccountBalance works: ${tokenBalance.amount}`);
});

Deno.test("local client completes instruction lookup table coverage with supplemental ALT", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const payer = await Keypair.generate();

    const coveredA = (await Keypair.generate()).publicKey;
    const coveredB = (await Keypair.generate()).publicKey;
    const missing = (await Keypair.generate()).publicKey;
    const existingA = await client.createLookupTable(payer, [coveredA]);
    const existingB = await client.createLookupTable(payer, [coveredB]);

    const programId = PublicKey.unique();
    const instructions = [{
        programId,
        keys: [
            { pubkey: coveredA, isSigner: false, isWritable: false },
            { pubkey: coveredB, isSigner: false, isWritable: false },
            { pubkey: missing, isSigner: false, isWritable: false },
            { pubkey: missing, isSigner: false, isWritable: false },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        ],
        data: new Uint8Array(),
    }];

    const lookupTables = await client.ensureLookupTableInstructionCoverage(
        payer,
        [existingA, existingB],
        instructions,
    );

    assertEquals(
        lookupTables.map((pk) => pk.toBase58()).slice(0, 2),
        [existingA.toBase58(), existingB.toBase58()],
    );
    assertEquals(lookupTables.length, 3);

    const supplemental = await client.getAccount(lookupTables[2], {
        localOnly: true,
    });
    assert(supplemental);
    assertEquals(
        parseAltAccount(supplemental.data).map((pk) => pk.toBase58()),
        [missing.toBase58()],
    );

    const unchanged = await client.ensureLookupTableInstructionCoverage(
        payer,
        lookupTables,
        instructions,
    );
    assertEquals(
        unchanged.map((pk) => pk.toBase58()),
        lookupTables.map((pk) => pk.toBase58()),
    );
});

// ============================================================================
// Lookup table helpers
// ============================================================================

Deno.test("altKeysFromIxs skips signers and deduplicates", () => {
    const programId = PublicKey.unique();
    const signer = PublicKey.unique();
    const accountA = PublicKey.unique();
    const accountB = PublicKey.unique();

    const keys = altKeysFromIxs([{
        programId,
        keys: [
            { pubkey: signer, isSigner: true, isWritable: true },
            { pubkey: accountA, isSigner: false, isWritable: false },
            { pubkey: accountA, isSigner: false, isWritable: true },
            { pubkey: accountB, isSigner: false, isWritable: false },
        ],
        data: new Uint8Array(),
    }]);

    assertEquals(
        keys.map((pk) => pk.toBase58()),
        [accountA.toBase58(), accountB.toBase58()],
    );
});

Deno.test("altKeysFromTx excludes program ids and signers", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const payer = await Keypair.generate();
    const programId = PublicKey.unique();
    const staticAccount = PublicKey.unique();
    const instructions = [{
        programId,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: staticAccount, isSigner: false, isWritable: false },
        ],
        data: new Uint8Array(),
    }];
    const tx = await buildVersionedTx(client, payer, instructions);

    assertEquals(
        altKeysFromTx(tx, instructions).map((pk) => pk.toBase58()),
        [staticAccount.toBase58()],
    );
});

Deno.test("local client resolveLookupTables parses tables and warps by default", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const authority = (await Keypair.generate()).publicKey;
    const address = (await Keypair.generate()).publicKey;
    const lookupTable = (await Keypair.generate()).publicKey;
    const lastExtendedSlot = 500n;

    plantLookupTable(client, lookupTable, [address], authority, lastExtendedSlot);
    const slotBefore = client.svm.getClockInfo().slot;

    const result = await client.resolveLookupTables([lookupTable]);

    assertEquals(result.maxExtendedSlot, lastExtendedSlot);
    assertEquals(result.resolved.length, 1);
    assertEquals(result.resolved[0].accountKey.toBase58(), lookupTable.toBase58());
    assertEquals(
        result.resolved[0].addresses.map((pk) => pk.toBase58()),
        [address.toBase58()],
    );
    assert(
        client.svm.getClockInfo().slot >= Number(lastExtendedSlot + 1n),
        "should warp past last extended slot",
    );
    assert(
        client.svm.getClockInfo().slot >= slotBefore,
        "warmup should not move slot backwards",
    );
});

Deno.test("local client resolveLookupTables respects warmup: false", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const authority = (await Keypair.generate()).publicKey;
    const address = (await Keypair.generate()).publicKey;
    const lookupTable = (await Keypair.generate()).publicKey;

    plantLookupTable(client, lookupTable, [address], authority, 900n);
    const slotBefore = client.svm.getClockInfo().slot;

    const result = await client.resolveLookupTables([lookupTable], {
        warmup: false,
    });

    assertEquals(result.maxExtendedSlot, 900n);
    assertEquals(client.svm.getClockInfo().slot, slotBefore);
});

Deno.test("local client resolveLookupTables throws when ALT is missing", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const missing = PublicKey.unique();

    await assertRejects(
        () => client.resolveLookupTables([missing], { label: "test-missing-alt" }),
        Error,
        "test-missing-alt: ALT account not found",
    );
});

Deno.test("local client exceedsWireLimit reports small and large transactions", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const payer = await Keypair.generate();
    const programId = PublicKey.unique();

    const small = makeInstructionWithKeys(programId, payer.publicKey, []);
    assertEquals(
        await client.exceedsWireLimit(payer, [small], { warmup: false }),
        false,
    );

    const manyKeys = await Promise.all(
        Array.from({ length: 20 }, async () => (await Keypair.generate()).publicKey),
    );
    const large = makeInstructionWithKeys(programId, payer.publicKey, manyKeys);
    assertEquals(
        await client.exceedsWireLimit(payer, [large], {
            maxWireSize: 300,
            warmup: false,
        }),
        true,
    );
});

Deno.test("local client exceedsWireLimit shrinks when lookup tables cover accounts", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const payer = await Keypair.generate();
    const programId = PublicKey.unique();
    const accounts = await Promise.all(
        Array.from({ length: 12 }, async () => (await Keypair.generate()).publicKey),
    );
    const lookupTable = await client.createLookupTable(payer, accounts);
    const instructions = [makeInstructionWithKeys(
        programId,
        payer.publicKey,
        accounts,
    )];

    assertEquals(
        await client.exceedsWireLimit(payer, instructions, {
            lookupTables: [],
            maxWireSize: 400,
            warmup: false,
        }),
        true,
    );
    assertEquals(
        await client.exceedsWireLimit(payer, instructions, {
            lookupTables: [lookupTable],
            maxWireSize: 400,
            warmup: false,
        }),
        false,
    );
});

Deno.test("local client autoAlt returns null for small transactions", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const payer = await Keypair.generate();
    const programId = PublicKey.unique();
    const instructions = [makeInstructionWithKeys(programId, payer.publicKey, [])];
    const tx = await buildVersionedTx(client, payer, instructions);

    assertStrictEquals(await client.autoAlt(payer, tx, instructions), null);
});

Deno.test("local client autoAlt creates supplemental ALT for oversized transactions", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const payer = await Keypair.generate();
    const programId = PublicKey.unique();
    const compressible = await Promise.all(
        Array.from({ length: 20 }, async () => (await Keypair.generate()).publicKey),
    );
    const instructions = [makeInstructionWithKeys(
        programId,
        payer.publicKey,
        compressible,
    )];
    const tx = await buildVersionedTx(client, payer, instructions);
    const maxWireSize = 300;
    assert(
        tx.serialize().length > maxWireSize,
        "fixture should exceed the test wire limit",
    );

    const supplemental = await client.autoAlt(payer, tx, instructions, {
        maxWireSize,
    });
    assert(supplemental);
    assertEquals(
        supplemental.addresses.map((pk) => pk.toBase58()).sort(),
        compressible.map((pk) => pk.toBase58()).sort(),
    );

    const account = await client.getAccount(supplemental.accountKey, {
        localOnly: true,
    });
    assert(account);
    assertEquals(
        parseAltAccount(account.data).map((pk) => pk.toBase58()).sort(),
        compressible.map((pk) => pk.toBase58()).sort(),
    );
});

Deno.test("local client autoAlt returns null when no compressible static keys exist", async () => {
    const client = new LocalClient({
        rpcEndpoint: DEFAULT_RPC,
        autoFetchAccounts: false,
    });
    const payer = await Keypair.generate();
    const programId = PublicKey.unique();
    const instructions = [{
        programId,
        keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
        data: new Uint8Array(),
    }];
    const tx = await buildVersionedTx(client, payer, instructions);

    assertStrictEquals(
        await client.autoAlt(payer, tx, instructions, { maxWireSize: 1 }),
        null,
    );
});

Deno.test("rpc client resolveLookupTables handles empty input", async () => {
    const client = new RpcClient(DEFAULT_RPC);
    const result = await client.resolveLookupTables([]);

    assertEquals(result.resolved, []);
    assertEquals(result.maxExtendedSlot, 0n);
});

Deno.test(
    "rpc client exceedsWireLimit uses RPC blockhash",
    { ignore: !Deno.env.get("SOLANA_RPC_URL") },
    async () => {
        const client = new RpcClient(Deno.env.get("SOLANA_RPC_URL")!);
        const payer = await Keypair.generate();
        const programId = PublicKey.unique();
        const instructions = [makeInstructionWithKeys(programId, payer.publicKey, [])];

        assertEquals(
            await client.exceedsWireLimit(payer, instructions, { maxWireSize: 50 }),
            true,
        );
        assertEquals(
            await client.exceedsWireLimit(payer, instructions, { maxWireSize: 10_000 }),
            false,
        );
    },
);

// ============================================================================
// Deploy Program Tests
// ============================================================================

Deno.test("local client: deploy non-upgradeable program and execute", async () => {
    const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const payer = await Keypair.generate();
    const programKeypair = await Keypair.generate();

    // Read a real ELF binary
    const elfBytes = await Deno.readFile(
        new URL(
            "../../../litesvm/test_programs/target/deploy/counter.so",
            import.meta.url,
        ),
    );

    // Deploy
    const result = await client.deployProgram(elfBytes, { programKeypair });
    assertEquals(result.id.toBase58(), programKeypair.publicKey.toBase58());
    assertEquals(result.keypair, programKeypair);
    assert(
        !result.programDataAddress,
        "Non-upgradeable should not have programDataAddress",
    );

    // Verify program account is executable
    const account = client.svm.getAccount(programKeypair.publicKey.toBytes());
    assert(account !== null, "Program account should exist");
    assert(account!.executable, "Program account should be executable");

    // Execute the deployed program: counter increment
    // Counter program uses 4-byte u32 data and instruction data [0, deduper]
    await client.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
    const dataAccount = PublicKey.unique();
    client.svm.setAccount(dataAccount.toBytes(), {
        lamports: 5,
        data: new Uint8Array(4), // u32 counter
        owner: programKeypair.publicKey.toBytes(),
        executable: false,
        rent_epoch: 0,
    });

    const tx = new Transaction(payer.publicKey, await client.latestBlockhash())
        .add({
            programId: programKeypair.publicKey,
            keys: [{ pubkey: dataAccount, isSigner: false, isWritable: true }],
            data: new Uint8Array([0, 0]), // increment instruction + deduper
        });
    await tx.sign(payer);

    const txResult = await client.sendTransaction(tx);
    assertEquals(txResult.meta?.err, null, "Counter increment should succeed");

    // Verify counter was incremented to 1
    const updatedAccount = client.svm.getAccount(dataAccount.toBytes());
    const counterValue = new DataView(
        updatedAccount!.data.buffer,
        updatedAccount!.data.byteOffset,
        updatedAccount!.data.byteLength,
    ).getUint32(0, true);
    assertEquals(counterValue, 1, "Counter should be 1 after one increment");

    console.log("Non-upgradeable deploy + execute works!");
});

Deno.test("local client: deploy upgradeable program", async () => {
    const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const programKeypair = await Keypair.generate();
    const authority = await Keypair.generate();

    const elfBytes = await Deno.readFile(
        new URL(
            "../../../litesvm/test_programs/target/deploy/counter.so",
            import.meta.url,
        ),
    );

    const result = await client.deployProgram(elfBytes, {
        programKeypair,
        upgradeAuthority: authority,
    });

    assertEquals(result.id.toBase58(), programKeypair.publicKey.toBase58());
    assert(
        result.programDataAddress,
        "Upgradeable should have programDataAddress",
    );

    // Verify program account structure
    const programAccount = client.svm.getAccount(
        programKeypair.publicKey.toBytes(),
    );
    assert(programAccount !== null, "Program account should exist");
    assert(programAccount!.executable, "Program account should be executable");
    assertEquals(
        programAccount!.data.length,
        36,
        "Program account data should be 36 bytes",
    );

    // Verify programdata account structure
    const programDataAccount = client.svm.getAccount(
        result.programDataAddress!.toBytes(),
    );
    assert(programDataAccount !== null, "ProgramData account should exist");
    assert(
        !programDataAccount!.executable,
        "ProgramData account should not be executable",
    );
    // Header (45 bytes) + ELF
    assertEquals(
        programDataAccount!.data.length,
        45 + elfBytes.length,
        "ProgramData should contain header + ELF",
    );

    // Verify upgrade authority is set (byte 12 = 1 = Some, bytes 13-44 = authority pubkey)
    assertEquals(programDataAccount!.data[12], 1, "Authority should be Some");
    const storedAuthority = programDataAccount!.data.slice(13, 45);
    const expectedAuthority = authority.publicKey.toBytes();
    for (let i = 0; i < 32; i++) {
        assertEquals(
            storedAuthority[i],
            expectedAuthority[i],
            `Authority byte ${i} should match`,
        );
    }

    console.log("Upgradeable deploy works!");
});

Deno.test("local client: immutable deploy drops the upgrade authority", async () => {
    const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const authority = await Keypair.generate();
    // A real ELF is required: LiteSVM validates the program account's ELF when
    // the upgradeable program/ProgramData accounts are injected.
    const elfBytes = await Deno.readFile(
        new URL(
            "../../../litesvm/src/programs/elf/spl_memo-3.0.0.so",
            import.meta.url,
        ),
    );

    // Control: a normal upgradeable deploy retains the authority → Some(authority).
    const upgradeable = await client.deployProgram(elfBytes, {
        programKeypair: await Keypair.generate(),
        upgradeAuthority: authority,
    });
    const upgradeableData = client.svm.getAccount(
        upgradeable.programDataAddress!.toBytes(),
    )!.data;
    assertEquals(upgradeableData[12], 1, "upgradeable: authority should be Some");
    const storedAuthority = upgradeableData.slice(13, 45);
    const expectedAuthority = authority.publicKey.toBytes();
    for (let i = 0; i < 32; i++) {
        assertEquals(storedAuthority[i], expectedAuthority[i], `authority byte ${i}`);
    }

    // Immutable: deployed under the authority, then dropped → Option::None, and
    // no authority pubkey is stored.
    const immutable = await client.deployProgram(elfBytes, {
        programKeypair: await Keypair.generate(),
        upgradeAuthority: authority,
        immutable: true,
    });
    const immutableData = client.svm.getAccount(
        immutable.programDataAddress!.toBytes(),
    )!.data;
    assertEquals(immutableData[12], 0, "immutable: authority should be None");
    assert(
        immutableData.slice(13, 45).every((b) => b === 0),
        "immutable: no authority pubkey should be stored",
    );

    console.log("Immutable deploy drops the upgrade authority!");
});

// ============================================================================
// SPL vs Token-2022 balance resolution
// ============================================================================

function encodeBase64Bytes(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/**
 * A JSON-RPC stub that answers only what `getTokenBalance` asks, and
 * records which accounts were looked up. Only `funded_ata` holds a token
 * account, so the returned balance proves which address the client derived.
 */
function stubTokenRpc(opts: {
    mint: PublicKey;
    owner: PublicKey;
    mint_program: string;
    funded_ata: string;
    amount: string;
}) {
    const queried: string[] = [];
    const account = (owner: string, data: Uint8Array, lamports: number) => ({
        lamports,
        executable: false,
        rentEpoch: 0,
        owner,
        data: [encodeBase64Bytes(data), "base64"],
    });
    // The amount has to live in the account bytes, not just the
    // getTokenAccountBalance reply: LocalClient parses the token account
    // directly, while RpcClient asks the node for the decoded balance.
    const token_account_data = createTokenAccountData({
        mint: opts.mint,
        owner: opts.owner,
        amount: BigInt(opts.amount),
    });
    const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
        const { method, params } = await req.json();
        const result = (value: unknown) =>
            Response.json({ jsonrpc: "2.0", id: 1, result: value });
        if (method === "getAccountInfo") {
            const [address] = params as [string];
            queried.push(address);
            if (address === opts.mint.toBase58()) {
                return result({
                    value: account(
                        opts.mint_program,
                        new Uint8Array(MINT_ACCOUNT_SIZE),
                        1_461_600,
                    ),
                });
            }
            if (address === opts.funded_ata) {
                return result({
                    value: account(
                        opts.mint_program,
                        token_account_data,
                        2_039_280,
                    ),
                });
            }
            return result({ value: null });
        }
        if (method === "getTokenAccountBalance") {
            return result({
                value: {
                    amount: opts.amount,
                    decimals: 6,
                    uiAmount: 0,
                    uiAmountString: "0",
                },
            });
        }
        return result(null);
    });
    const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    return { server, queried, url };
}

Deno.test("rpc client reads spl balances from the default associated token account", async () => {
    const mint = PublicKey.unique();
    const owner = PublicKey.unique();
    const ata = await getSPLAssociatedTokenAddress(mint, owner);
    const { server, url } = stubTokenRpc({
        mint,
        owner,
        mint_program: TOKEN_PROGRAM_PUBKEY,
        funded_ata: ata.toBase58(),
        amount: "999",
    });
    try {
        const balance = await new RpcClient(url).getTokenBalance(
            mint,
            owner,
        );
        assertEquals(balance.amount, "999");
    } finally {
        await server.shutdown();
    }
});

Deno.test("rpc client reads token-2022 balances from the token-2022 associated token account", async () => {
    const mint = PublicKey.unique();
    const owner = PublicKey.unique();
    const token_2022_ata = await getSPLAssociatedTokenAddress(
        mint,
        owner,
        TOKEN_2022_PROGRAM_PUBKEY,
    );
    const spl_ata = await getSPLAssociatedTokenAddress(mint, owner);
    // Only the Token-2022 account is funded, so deriving under the SPL program
    // would find nothing and report a zero balance instead of the real one.
    const { server, queried, url } = stubTokenRpc({
        mint,
        owner,
        mint_program: TOKEN_2022_PROGRAM_PUBKEY,
        funded_ata: token_2022_ata.toBase58(),
        amount: "12345",
    });
    try {
        const balance = await new RpcClient(url).getTokenBalance(
            mint,
            owner,
        );
        assertEquals(balance.amount, "12345");
        assert(queried.includes(token_2022_ata.toBase58()));
        assert(!queried.includes(spl_ata.toBase58()));
    } finally {
        await server.shutdown();
    }
});

Deno.test("local client forks token balances it has not been seeded with", async () => {
    const mint = PublicKey.unique();
    const owner = PublicKey.unique();
    const token_2022_ata = await getSPLAssociatedTokenAddress(
        mint,
        owner,
        TOKEN_2022_PROGRAM_PUBKEY,
    );
    // Nothing is planted in the sandbox, so the balance can only be found by
    // pulling the mint and the token account through the forking RPC.
    const { server, url } = stubTokenRpc({
        mint,
        owner,
        mint_program: TOKEN_2022_PROGRAM_PUBKEY,
        funded_ata: token_2022_ata.toBase58(),
        amount: "777",
    });
    try {
        const client = new LocalClient({ rpcEndpoint: url });
        const balance = await client.getTokenBalance(mint, owner);
        assertEquals(balance.amount, "777");
    } finally {
        await server.shutdown();
    }
});

Deno.test("versioned transaction serializes when unsigned", async () => {
    const payer = await Keypair.generate();
    const message = MessageV0.fromInstructions({
        payerKey: payer.publicKey,
        recentBlockhash: PublicKey.unique().toBase58(),
        instructions: [SystemProgram.transfer(payer.publicKey, PublicKey.unique(), 1_000)],
    });

    const unsigned = new VersionedTransaction(message).serialize();
    assertEquals(
        VersionedTransaction.fromBytes(unsigned).signatures.length,
        message.header.requiredSignatures,
    );

    const signed = new VersionedTransaction(message);
    await signed.sign([payer]);
    assertEquals(unsigned.length, signed.serialize().length);
});
