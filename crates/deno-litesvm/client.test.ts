import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  TokenProgram,
  AssociatedTokenProgram,
  getAssociatedTokenAddress,
} from "./solana.ts";
import { LiteSvm } from "./mod.ts";
import { LocalClient, RpcClient, encodeTransaction, type DeployProgramResult } from "./client.ts";
import { parseTokenAccountData, KNOWN_MINTS } from "./utils.ts";

const DEFAULT_RPC = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.devnet.solana.com";


Deno.test("fork client mirrors LiteSVM primitives", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
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

  const account = await client.getAccount(recipient);
  assert(account);
  assertEquals(account.lamports, 1_000_000);
});

Deno.test("in-process fork uses the same client surface", async () => {
  const svm = new LiteSvm();
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC, svm });

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

  const account = await client.getAccount(recipient.publicKey);
  assert(account);
  assertEquals(account.lamports, 250_000);
});

Deno.test(
  "simulate on one fork then execute on another",
  async () => {
    // Two independent fork clients — proves the same transaction logic
    // works across separate SVM instances.
    const simulationClient = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
    const executionClient = new LocalClient({ rpcEndpoint: DEFAULT_RPC });

    const payer = await Keypair.generate();
    const recipient = (await Keypair.generate()).publicKey;
    const lamports = 500_000;

    // Fund payer on both forks
    await simulationClient.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
    await executionClient.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);

    // Build and simulate on the first fork
    const simMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: await simulationClient.latestBlockhash(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports,
        }),
      ],
    }).compileToV0Message();

    const simTx = new VersionedTransaction(simMessage);
    await simTx.sign([payer]);

    const simulation = await simulationClient.simulateTransaction(simTx);
    assertEquals(simulation.status, "ok");

    // Build and execute on the second fork
    const execMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: await executionClient.latestBlockhash(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports,
        }),
      ],
    }).compileToV0Message();

    const execTx = new VersionedTransaction(execMessage);
    await execTx.sign([payer]);

    const sendResult = await executionClient.sendTransaction(execTx);
    assertEquals(sendResult.status, "ok");

    const account = await executionClient.getAccount(recipient);
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
    const senderAta = await getAssociatedTokenAddress(mint, sender.publicKey);
    const recipientAta = await getAssociatedTokenAddress(mint, recipient.publicKey);

    // Step 1: Create the mint account
    const MINT_SIZE = 82; // Size of a mint account
    const mintRent = 1_461_600; // Rent exemption for mint (~0.00146 SOL)

    const createMintTx = new Transaction({
      feePayer: mintAuthority.publicKey,
      recentBlockhash: await client.latestBlockhash(),
    }).add(
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
    assertEquals(createMintResult.status, "ok", "Failed to create mint");

    // Step 2: Create sender's associated token account and mint tokens
    const TOKEN_ACCOUNT_SIZE = 165;
    const tokenAccountRent = 2_039_280;

    const createSenderAtaTx = new Transaction({
      feePayer: sender.publicKey,
      recentBlockhash: await client.latestBlockhash(),
    }).add(
      AssociatedTokenProgram.create({
        payer: sender.publicKey,
        associatedToken: senderAta,
        owner: sender.publicKey,
        mint,
      }),
    );
    await createSenderAtaTx.sign(sender);

    const createSenderAtaResult = await client.sendTransaction(createSenderAtaTx);
    assertEquals(createSenderAtaResult.status, "ok", "Failed to create sender ATA");

    // Step 3: Mint tokens to sender
    const mintAmount = BigInt(1_000_000_000); // 1 token with 9 decimals

    const mintToTx = new Transaction({
      feePayer: mintAuthority.publicKey,
      recentBlockhash: await client.latestBlockhash(),
    }).add(
      TokenProgram.mintTo({
        mint,
        destination: senderAta,
        authority: mintAuthority.publicKey,
        amount: mintAmount,
      }),
    );
    await mintToTx.sign(mintAuthority);

    const mintToResult = await client.sendTransaction(mintToTx);
    assertEquals(mintToResult.status, "ok", "Failed to mint tokens");

    // Step 4: Create recipient's associated token account
    const createRecipientAtaTx = new Transaction({
      feePayer: sender.publicKey,
      recentBlockhash: await client.latestBlockhash(),
    }).add(
      AssociatedTokenProgram.create({
        payer: sender.publicKey,
        associatedToken: recipientAta,
        owner: recipient.publicKey,
        mint,
      }),
    );
    await createRecipientAtaTx.sign(sender);

    const createRecipientAtaResult = await client.sendTransaction(createRecipientAtaTx);
    assertEquals(createRecipientAtaResult.status, "ok", "Failed to create recipient ATA");

    // Step 5: Transfer tokens from sender to recipient
    const transferAmount = BigInt(500_000_000); // 0.5 tokens

    const transferTx = new Transaction({
      feePayer: sender.publicKey,
      recentBlockhash: await client.latestBlockhash(),
    }).add(
      TokenProgram.transfer({
        source: senderAta,
        destination: recipientAta,
        owner: sender.publicKey,
        amount: transferAmount,
      }),
    );
    await transferTx.sign(sender);

    const transferResult = await client.sendTransaction(transferTx);
    assertEquals(transferResult.status, "ok", "Failed to transfer tokens");

    // Verify balances
    const senderAtaAccount = await client.getAccount(senderAta);
    const recipientAtaAccount = await client.getAccount(recipientAta);

    assert(senderAtaAccount, "Sender ATA should exist");
    assert(recipientAtaAccount, "Recipient ATA should exist");

    // Parse token account data to get balances
    // Token account structure: mint (32) + owner (32) + amount (8) + ...
    const senderBalance = new DataView(senderAtaAccount.data.buffer).getBigUint64(64, true);
    const recipientBalance = new DataView(recipientAtaAccount.data.buffer).getBigUint64(64, true);

    assertEquals(senderBalance, mintAmount - transferAmount, "Sender should have 0.5 tokens remaining");
    assertEquals(recipientBalance, transferAmount, "Recipient should have 0.5 tokens");

    console.log(`SPL Token transfer successful!`);
    console.log(`  Sender balance: ${senderBalance} (${Number(senderBalance) / 1e9} tokens)`);
    console.log(`  Recipient balance: ${recipientBalance} (${Number(recipientBalance) / 1e9} tokens)`);
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
    const senderAta = await getAssociatedTokenAddress(usdcMint, sender.publicKey);
    const recipientAta = await getAssociatedTokenAddress(usdcMint, recipient.publicKey);

    // HIJACK: Set sender's USDC balance to 1000 USDC (USDC has 6 decimals)
    const initialUsdcAmount = BigInt(1000_000_000); // 1000 USDC
    svm.setTokenBalance({
      tokenAccount: senderAta,
      mint: usdcMint,
      owner: sender.publicKey,
      amount: initialUsdcAmount,
    });

    // Also create recipient's token account with 0 balance
    svm.setTokenBalance({
      tokenAccount: recipientAta,
      mint: usdcMint,
      owner: recipient.publicKey,
      amount: BigInt(0),
    });

    // Verify the hijacked balance
    const hijackedBalance = svm.getTokenBalance(senderAta);
    assertEquals(hijackedBalance, initialUsdcAmount, "Hijacked balance should be 1000 USDC");

    console.log(`Hijacked USDC balance: ${Number(hijackedBalance) / 1e6} USDC`);

    // Now transfer 250 USDC from sender to recipient
    const transferAmount = BigInt(250_000_000); // 250 USDC

    const transferTx = new Transaction({
      feePayer: sender.publicKey,
      recentBlockhash: await client.latestBlockhash(),
    }).add(
      TokenProgram.transfer({
        source: senderAta,
        destination: recipientAta,
        owner: sender.publicKey,
        amount: transferAmount,
      }),
    );
    await transferTx.sign(sender);

    const transferResult = await client.sendTransaction(transferTx);
    assertEquals(transferResult.status, "ok", "USDC transfer should succeed");

    // Verify final balances
    const senderFinalBalance = svm.getTokenBalance(senderAta);
    const recipientFinalBalance = svm.getTokenBalance(recipientAta);

    assertEquals(
      senderFinalBalance,
      initialUsdcAmount - transferAmount,
      "Sender should have 750 USDC",
    );
    assertEquals(recipientFinalBalance, transferAmount, "Recipient should have 250 USDC");

    console.log(`\nUSDC Transfer successful!`);
    console.log(`  Sender USDC balance: ${Number(senderFinalBalance) / 1e6} USDC`);
    console.log(`  Recipient USDC balance: ${Number(recipientFinalBalance) / 1e6} USDC`);
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

    // Use a known USDC holder with standard token account format (165 bytes)
    // This is Coinbase's USDC custody wallet ATA
    const knownUsdcHolder = new PublicKey("FHKqMXmWjwTebBfnqPEUBnK4SsuBqN3YieMc3p9gBVY1");

    // Fetch the real USDC account from mainnet
    const holderAccount = await client.getAccount(knownUsdcHolder);

    // If account doesn't exist or is wrong size, use synthetic approach
    if (!holderAccount || holderAccount.data.length !== 165) {
      console.log(`Account not found or wrong size (${holderAccount?.data.length ?? 0} bytes)`);
      console.log("Using synthetic approach for mainnet USDC heist...\n");

      // Use synthetic approach - create our own token account with USDC balance
      const usdcMint = KNOWN_MINTS.USDC_MAINNET;

      // Fetch the USDC mint first
      const mintAccount = await client.getAccount(usdcMint);
      if (!mintAccount) {
        console.log("Could not fetch USDC mint - skipping test");
        return;
      }

      // Create impersonator and recipient
      const impersonator = await Keypair.generate();
      const recipient = await Keypair.generate();
      await client.requestAirdrop(impersonator.publicKey, LAMPORTS_PER_SOL);
      await client.requestAirdrop(recipient.publicKey, LAMPORTS_PER_SOL);

      // Create ATAs
      const impersonatorAta = await getAssociatedTokenAddress(usdcMint, impersonator.publicKey);
      const recipientAta = await getAssociatedTokenAddress(usdcMint, recipient.publicKey);

      // Hijack: Give impersonator 10 million USDC
      const hijackedAmount = BigInt(10_000_000_000_000); // 10M USDC (6 decimals)
      svm.setTokenBalance({
        tokenAccount: impersonatorAta,
        mint: usdcMint,
        owner: impersonator.publicKey,
        amount: hijackedAmount,
      });

      // Set up recipient ATA with 0 balance
      svm.setTokenBalance({
        tokenAccount: recipientAta,
        mint: usdcMint,
        owner: recipient.publicKey,
        amount: BigInt(0),
      });

      console.log(`Hijacked ${Number(hijackedAmount) / 1e6} USDC into impersonator's account`);

      // Transfer 1M USDC
      const transferAmount = BigInt(1_000_000_000_000); // 1M USDC

      const transferTx = new Transaction({
        feePayer: impersonator.publicKey,
        recentBlockhash: await client.latestBlockhash(),
      }).add(
        TokenProgram.transfer({
          source: impersonatorAta,
          destination: recipientAta,
          owner: impersonator.publicKey,
          amount: transferAmount,
        }),
      );
      await transferTx.sign(impersonator);

      const transferResult = await client.sendTransaction(transferTx);
      assertEquals(transferResult.status, "ok", "Hijacked USDC transfer should succeed");

      // Verify
      const finalBalance = svm.getTokenBalance(recipientAta);
      assertEquals(finalBalance, transferAmount);

      console.log(`\n🏴‍☠️ Synthetic USDC Heist successful!`);
      console.log(`  Transferred ${Number(transferAmount) / 1e6} USDC`);
      console.log(`  Recipient now has: ${Number(finalBalance) / 1e6} USDC`);
      return;
    }

    // Real mainnet holder found! Parse and hijack
    const parsedHolder = parseTokenAccountData(holderAccount.data);
    const realBalance = parsedHolder.amount;

    console.log(`\nReal USDC holder balance: ${Number(realBalance) / 1e6} USDC`);

    // Generate a recipient wallet
    const recipient = await Keypair.generate();
    await client.requestAirdrop(recipient.publicKey, LAMPORTS_PER_SOL);

    // Create recipient's USDC ATA
    const usdcMint = KNOWN_MINTS.USDC_MAINNET;
    const recipientAta = await getAssociatedTokenAddress(usdcMint, recipient.publicKey);

    // Ensure the USDC mint account exists
    const mintAccount = await client.getAccount(usdcMint);
    if (!mintAccount) {
      console.log("Could not fetch USDC mint - skipping test");
      return;
    }

    svm.setTokenBalance({
      tokenAccount: recipientAta,
      mint: usdcMint,
      owner: recipient.publicKey,
      amount: BigInt(0),
    });

    // HIJACK: Modify the holder account to make our impersonator the owner
    const impersonator = await Keypair.generate();
    await client.requestAirdrop(impersonator.publicKey, LAMPORTS_PER_SOL);

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

    const transferTx = new Transaction({
      feePayer: impersonator.publicKey,
      recentBlockhash: await client.latestBlockhash(),
    }).add(
      TokenProgram.transfer({
        source: knownUsdcHolder,
        destination: recipientAta,
        owner: impersonator.publicKey,
        amount: transferAmount,
      }),
    );
    await transferTx.sign(impersonator);

    const transferResult = await client.sendTransaction(transferTx);
    if (transferResult.status === "err") {
      console.log("Transfer error:", transferResult.err);
      if ("meta" in transferResult) {
        console.log("Logs:", transferResult.meta.logs);
      }
    }
    assertEquals(transferResult.status, "ok", "Hijacked USDC transfer should succeed");

    const recipientFinalBalance = svm.getTokenBalance(recipientAta);
    assertEquals(recipientFinalBalance, transferAmount);

    console.log(`\n🏴‍☠️ Real USDC Heist successful!`);
    console.log(`  Stole ${Number(transferAmount) / 1e6} USDC from real mainnet holder`);
    console.log(`  Recipient now has: ${Number(recipientFinalBalance) / 1e6} USDC`);
  },
);

Deno.test("svm.setTokenBalance and svm.modifyTokenBalance work correctly", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
  const svm = client.svm;

  const owner = await Keypair.generate();
  const mint = (await Keypair.generate()).publicKey;
  const tokenAccount = (await Keypair.generate()).publicKey;

  // Set initial balance
  svm.setTokenBalance({
    tokenAccount,
    mint,
    owner: owner.publicKey,
    amount: BigInt(1000),
  });

  // Verify initial balance
  let balance = svm.getTokenBalance(tokenAccount);
  assertEquals(balance, BigInt(1000));

  // Parse and verify structure
  const account = svm.getAccount(tokenAccount.toBytes())!;
  const parsed = parseTokenAccountData(account.data);
  assertEquals(parsed.amount, BigInt(1000));
  assertEquals(parsed.state, 1); // Initialized
  assertEquals(new PublicKey(parsed.mint).toBase58(), mint.toBase58());
  assertEquals(new PublicKey(parsed.owner).toBase58(), owner.publicKey.toBase58());

  // Modify balance
  svm.modifyTokenBalance(tokenAccount, BigInt(5000));

  // Verify modified balance
  balance = svm.getTokenBalance(tokenAccount);
  assertEquals(balance, BigInt(5000));

  // Verify other fields unchanged
  const modifiedAccount = svm.getAccount(tokenAccount.toBytes())!;
  const modifiedParsed = parseTokenAccountData(modifiedAccount.data);
  assertEquals(new PublicKey(modifiedParsed.mint).toBase58(), mint.toBase58());
  assertEquals(new PublicKey(modifiedParsed.owner).toBase58(), owner.publicKey.toBase58());

  console.log("Token balance utilities work correctly!");
});

Deno.test("fork client: getBalance, getMinimumBalanceForRentExemption, isBlockhashValid", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
  const payer = await Keypair.generate();

  // Balance should be 0 before airdrop
  let balance = await client.getBalance(payer.publicKey);
  assertEquals(balance, 0);

  // Airdrop and check balance
  await client.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL);
  balance = await client.getBalance(payer.publicKey);
  assertEquals(balance, 5 * LAMPORTS_PER_SOL);

  // getMinimumBalanceForRentExemption should return a positive number
  const rentExempt = await client.getMinimumBalanceForRentExemption(165);
  assert(rentExempt > 0, "Rent exemption should be positive");

  // isBlockhashValid should always return true in local mode
  const valid = await client.isBlockhashValid("SomeBlockhash");
  assertEquals(valid, true);

  // getSlot and getBlockHeight return real values from Clock sysvar
  const slot = await client.getSlot();
  assert(typeof slot === "number", "Slot should be a number");
  const blockHeight = await client.getBlockHeight();
  assert(typeof blockHeight === "number", "Block height should be a number");

  console.log(`Local RPC methods work: balance=${balance}, rentExempt=${rentExempt}, slot=${slot}`);
});

Deno.test("fork client: getTokenAccountBalance via transport", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
  const svm = client.svm;

  const owner = await Keypair.generate();
  const mint = (await Keypair.generate()).publicKey;
  const tokenAccount = (await Keypair.generate()).publicKey;

  // Set up a token account with a known balance
  svm.setTokenBalance({
    tokenAccount,
    mint,
    owner: owner.publicKey,
    amount: BigInt(42_000_000),
  });

  // getTokenAccountBalance should return the balance through the client
  const tokenBalance = await client.getTokenAccountBalance(tokenAccount);
  assertEquals(tokenBalance.amount, "42000000");
  assertEquals(tokenBalance.uiAmountString, "42000000");

  console.log(`getTokenAccountBalance works: ${tokenBalance.amount}`);
});


Deno.test("fork client: warpToSlot changes slot", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });

  // Initial slot
  const initialSlot = await client.getSlot();

  // Warp to slot 1000
  client.warpToSlot(1000);
  const slotAfter = await client.getSlot();
  assertEquals(slotAfter, 1000);

  // Block height should also reflect the slot
  const blockHeight = await client.getBlockHeight();
  assertEquals(blockHeight, 1000);

  console.log(`warpToSlot: ${initialSlot} -> ${slotAfter}`);
});

Deno.test("fork client: getHealth, getVersion, getEpochInfo work locally", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });

  // getHealth should return "ok"
  const health = await client.getHealth();
  assertEquals(health, "ok");

  // getVersion should return litesvm info
  const version = await client.getVersion();
  assertEquals(version["solana-core"], "litesvm");
  assertEquals(version["feature-set"], 0);

  // getEpochInfo should return valid data
  const epochInfo = await client.getEpochInfo();
  assert(epochInfo.slotsInEpoch > 0, "Slots in epoch should be positive");
  assert(typeof epochInfo.epoch === "number", "Epoch should be a number");
  assert(typeof epochInfo.absoluteSlot === "number", "Absolute slot should be a number");

  console.log(`Local getEpochInfo: epoch=${epochInfo.epoch}, slotsInEpoch=${epochInfo.slotsInEpoch}`);
});

Deno.test("fork client: getGenesisHash and getTransactionCount work locally", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });

  // getGenesisHash should return a non-empty string (uses blockhash as stand-in)
  const genesisHash = await client.getGenesisHash();
  assert(genesisHash.length > 0, "Genesis hash should be non-empty");

  // getTransactionCount should return 0
  const txCount = await client.getTransactionCount();
  assertEquals(txCount, 0);

  console.log(`Local genesis hash: ${genesisHash}, tx count: ${txCount}`);
});

Deno.test("fork client: getTokenSupply reads mint data locally", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
  const svm = client.svm;

  // Create a fake mint account with supply=1000000000 and decimals=6
  const mint = (await Keypair.generate()).publicKey;
  const MINT_SIZE = 82;
  const mintData = new Uint8Array(MINT_SIZE);
  const view = new DataView(mintData.buffer);

  // Mint layout: mintAuthorityOption(4) + mintAuthority(32) + supply(8@36) + decimals(1@44) + isInitialized(1@45) + ...
  view.setUint32(0, 1, true); // mintAuthorityOption = Some
  // mintAuthority (32 bytes at offset 4) — leave as zeros
  view.setBigUint64(36, BigInt(1_000_000_000), true); // supply
  mintData[44] = 6; // decimals
  mintData[45] = 1; // isInitialized

  svm.setAccount(mint.toBytes(), {
    lamports: 1_461_600,
    data: mintData,
    owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBytes(),
    executable: false,
    rent_epoch: 0,
  });

  const supply = await client.getTokenSupply(mint);
  assertEquals(supply.amount, "1000000000");
  assertEquals(supply.decimals, 6);
  assertEquals(supply.uiAmount, 1000);

  console.log(`Local getTokenSupply: amount=${supply.amount}, decimals=${supply.decimals}, ui=${supply.uiAmount}`);
});

Deno.test("fork client: getProgramAccounts finds accounts locally", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
  const svm = client.svm;

  const programId = (await Keypair.generate()).publicKey;

  // Create 3 accounts owned by our program
  for (let i = 0; i < 3; i++) {
    const key = (await Keypair.generate()).publicKey;
    const data = new Uint8Array(32);
    data[0] = i;
    svm.setAccount(key.toBytes(), {
      lamports: 1_000_000,
      data,
      owner: programId.toBytes(),
      executable: false,
      rent_epoch: 0,
    });
  }

  const accounts = await client.getProgramAccounts(programId);
  assertEquals(accounts.length, 3, "Should find 3 program accounts");

  // Each should have the correct owner
  for (const acc of accounts) {
    assertEquals(acc.account.owner, programId.toBase58());
    assertEquals(acc.account.lamports, 1_000_000);
    assertEquals(acc.account.space, 32);
  }

  // Test with dataSize filter
  const filtered = await client.getProgramAccounts(programId, {
    filters: [{ dataSize: 32 }],
  });
  assertEquals(filtered.length, 3);

  const wrongSize = await client.getProgramAccounts(programId, {
    filters: [{ dataSize: 64 }],
  });
  assertEquals(wrongSize.length, 0);

  console.log(`getProgramAccounts found ${accounts.length} accounts`);
});

Deno.test("fork client: getTokenAccountsByOwner filters correctly", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
  const svm = client.svm;

  const owner = await Keypair.generate();
  const mint1 = (await Keypair.generate()).publicKey;
  const mint2 = (await Keypair.generate()).publicKey;
  const tokenAccount1 = (await Keypair.generate()).publicKey;
  const tokenAccount2 = (await Keypair.generate()).publicKey;

  // Create two token accounts for the same owner but different mints
  svm.setTokenBalance({
    tokenAccount: tokenAccount1,
    mint: mint1,
    owner: owner.publicKey,
    amount: BigInt(100),
  });
  svm.setTokenBalance({
    tokenAccount: tokenAccount2,
    mint: mint2,
    owner: owner.publicKey,
    amount: BigInt(200),
  });

  // Get all token accounts by owner (filter by Token program)
  const allAccounts = await client.getTokenAccountsByOwner(
    owner.publicKey,
    { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
  );
  assertEquals(allAccounts.length, 2, "Should find 2 token accounts for owner");

  // Filter by mint1
  const mint1Accounts = await client.getTokenAccountsByOwner(
    owner.publicKey,
    { mint: mint1 },
  );
  assertEquals(mint1Accounts.length, 1, "Should find 1 account for mint1");
  assertEquals(mint1Accounts[0].pubkey, tokenAccount1.toBase58());

  // Filter by mint2
  const mint2Accounts = await client.getTokenAccountsByOwner(
    owner.publicKey,
    { mint: mint2 },
  );
  assertEquals(mint2Accounts.length, 1, "Should find 1 account for mint2");
  assertEquals(mint2Accounts[0].pubkey, tokenAccount2.toBase58());

  console.log(`getTokenAccountsByOwner: all=${allAccounts.length}, mint1=${mint1Accounts.length}, mint2=${mint2Accounts.length}`);
});

Deno.test("fork client: getSignatureStatuses and getTransaction with history", async () => {
  const client = new LocalClient({ rpcEndpoint: DEFAULT_RPC });
  const svm = client.svm;

  // Enable transaction history
  svm.setTransactionHistory(100);

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
    lamports: 500_000,
  }));
  await tx.sign(payer);

  const result = await client.sendTransaction(tx);
  assertEquals(result.status, "ok");

  // Extract the base58 signature string from the result
  const sigBase58 = (result as { signature: string }).signature;
  assert(sigBase58.length > 0, "Signature should be non-empty");

  // getSignatureStatuses should find the transaction
  const statuses = await client.getSignatureStatuses([sigBase58]);
  assert(statuses[0] !== null, "Signature status should exist");
  assertEquals(statuses[0]!.err, null, "Transaction should not have error");
  assertEquals(statuses[0]!.confirmationStatus, "finalized");

  // getTransaction should return transaction details
  const txDetails = await client.getTransaction(sigBase58);
  assert(txDetails !== null, "Transaction details should exist");
  assert(txDetails!.meta !== null, "Transaction meta should exist");
  assertEquals(txDetails!.meta!.err, null, "Transaction should not have error");
  assert(txDetails!.meta!.logMessages!.length > 0, "Should have log messages");

  // Non-existent signature should return null
  const fakeStatuses = await client.getSignatureStatuses(["FakeSignature11111111111111111111111111111111111"]);
  assertEquals(fakeStatuses[0], null);

  console.log(`getSignatureStatuses and getTransaction work with history enabled`);
});

Deno.test(
  "rpc client: getBalance, getSlot, getBlockHeight, getEpochInfo, getVersion, getHealth",
  { ignore: !Deno.env.get("SOLANA_RPC_URL") },
  async () => {
    const rpcEndpoint = Deno.env.get("SOLANA_RPC_URL")!;
    const client = new RpcClient(rpcEndpoint);

    // getSlot should return a positive number
    const slot = await client.getSlot();
    assert(slot > 0, `Slot should be positive, got ${slot}`);

    // getBlockHeight should return a positive number
    const blockHeight = await client.getBlockHeight();
    assert(blockHeight > 0, `Block height should be positive, got ${blockHeight}`);

    // getEpochInfo should return valid epoch data
    const epochInfo = await client.getEpochInfo();
    assert(epochInfo.epoch >= 0, "Epoch should be non-negative");
    assert(epochInfo.slotsInEpoch > 0, "Slots in epoch should be positive");

    // getVersion should return a version string
    const version = await client.getVersion();
    assert(version["solana-core"].length > 0, "Version should be non-empty");

    // getHealth should return "ok"
    const health = await client.getHealth();
    assertEquals(health, "ok");

    // getBalance for a random address should be 0
    const randomKey = (await Keypair.generate()).publicKey;
    const balance = await client.getBalance(randomKey);
    assertEquals(balance, 0);

    console.log(`RPC methods work: slot=${slot}, blockHeight=${blockHeight}, epoch=${epochInfo.epoch}, version=${version["solana-core"]}`);
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
    new URL("../litesvm/test_programs/target/deploy/counter.so", import.meta.url),
  );

  // Deploy
  const result = await client.deployProgram(programKeypair, elfBytes);
  assertEquals(result.programId.toBase58(), programKeypair.publicKey.toBase58());
  assert(!result.programDataAddress, "Non-upgradeable should not have programDataAddress");

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

  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: await client.latestBlockhash(),
  }).add({
    programId: programKeypair.publicKey,
    keys: [{ pubkey: dataAccount, isSigner: false, isWritable: true }],
    data: new Uint8Array([0, 0]), // increment instruction + deduper
  });
  await tx.sign(payer);

  const txResult = await client.sendTransaction(tx);
  assertEquals(txResult.status, "ok", "Counter increment should succeed");

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
    new URL("../litesvm/test_programs/target/deploy/counter.so", import.meta.url),
  );

  const result = await client.deployProgram(programKeypair, elfBytes, {
    upgradeable: true,
    upgradeAuthority: authority,
  });

  assertEquals(result.programId.toBase58(), programKeypair.publicKey.toBase58());
  assert(result.programDataAddress, "Upgradeable should have programDataAddress");

  // Verify program account structure
  const programAccount = client.svm.getAccount(programKeypair.publicKey.toBytes());
  assert(programAccount !== null, "Program account should exist");
  assert(programAccount!.executable, "Program account should be executable");
  assertEquals(programAccount!.data.length, 36, "Program account data should be 36 bytes");

  // Verify programdata account structure
  const programDataAccount = client.svm.getAccount(result.programDataAddress!.toBytes());
  assert(programDataAccount !== null, "ProgramData account should exist");
  assert(!programDataAccount!.executable, "ProgramData account should not be executable");
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
    assertEquals(storedAuthority[i], expectedAuthority[i], `Authority byte ${i} should match`);
  }

  console.log("Upgradeable deploy works!");
});
