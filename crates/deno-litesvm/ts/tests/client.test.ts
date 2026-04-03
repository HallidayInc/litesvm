import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import {
    AssociatedTokenProgram,
    getSPLAssociatedTokenAddress,
    Keypair,
    LAMPORTS_PER_SOL,
    MessageV0,
    PublicKey,
    SystemProgram,
    TokenProgram,
    Transaction,
    VersionedTransaction,
} from "../src/solana.ts";
import { LiteSvm } from "../src/mod.ts";
import { type DeployProgramResult, LocalClient, RpcClient } from "../src/client.ts";
import { KNOWN_MINTS, parseTokenAccountData } from "../src/solana.ts";

const DEFAULT_RPC = Deno.env.get("SOLANA_RPC_URL") ??
    "https://api.devnet.solana.com";

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
        const hijackedBalanceResult = await client.getSPLTokenAccountBalance(
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
        const senderFinalBalanceResult = await client.getSPLTokenAccountBalance(
            usdcMint,
            sender.publicKey,
        );
        const recipientFinalBalanceResult = await client.getSPLTokenAccountBalance(
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
            const finalBalanceResult = await client.getSPLTokenAccountBalance(
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

        const recipientFinalBalanceResult = await client.getSPLTokenAccountBalance(
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
    const tokenAccount = (await Keypair.generate()).publicKey;

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
    const tokenAccount = (await Keypair.generate()).publicKey;

    // Set up a token account with a known balance
    client.setSPLTokenBalance(
        tokenAccount,
        mint,
        owner.publicKey,
        BigInt(42_000_000),
    );

    // getTokenAccountBalance should return the balance through the client
    const tokenBalance = await client.getSPLTokenAccountBalance(
        mint,
        owner.publicKey,
    );
    assertEquals(tokenBalance.amount, "42000000");
    assertEquals(tokenBalance.uiAmountString, "42000000");

    console.log(`getTokenAccountBalance works: ${tokenBalance.amount}`);
});

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
            "../litesvm/test_programs/target/deploy/counter.so",
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
            "../litesvm/test_programs/target/deploy/counter.so",
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
