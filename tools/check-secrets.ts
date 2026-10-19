/**
 * Validates the workflow's secrets before bot.ts reads them, without ever
 * printing their values. A malformed PRIVATE_KEY would otherwise reach the
 * public run log through JSON.parse's error message, which quotes the input
 * around the bad character, and GitHub only masks the secret as a whole.
 *
 * Also refuses to run when PRIVATE_KEY is one of the validator's own keys:
 * the bot wallet must be a separate wallet that only holds invoice money.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";

const fail = (message: string): never => {
  console.log(`::error::${message}`);
  process.exit(1);
};

const main = async () => {
  const { RPC_URL, VOTE_KEY, PRIVATE_KEY, LIST_ONLY } = process.env;
  const dryRun = LIST_ONLY === "1";

  if (!RPC_URL || !/^https:\/\/\S+$/.test(RPC_URL.trim())) {
    fail("The RPC_URL secret is missing or is not a single https:// address.");
  }

  let vote: PublicKey;
  try {
    vote = new PublicKey(VOTE_KEY ?? "");
  } catch {
    return fail(
      "The VOTE_KEY secret is missing or is not a Solana address (check for spaces or line breaks).",
    );
  }

  let payer: PublicKey | null = null;
  if (PRIVATE_KEY) {
    let bytes: unknown = null;
    try {
      bytes = JSON.parse(PRIVATE_KEY);
    } catch {}
    if (
      !Array.isArray(bytes) ||
      bytes.length !== 64 ||
      !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
    ) {
      fail(
        "The PRIVATE_KEY secret must be 64 numbers between 0 and 255 inside square brackets.",
      );
    }
    try {
      payer = Keypair.fromSecretKey(Uint8Array.from(bytes as number[])).publicKey;
    } catch {
      fail("The PRIVATE_KEY secret is not a valid Solana key.");
    }
  } else if (!dryRun) {
    fail("The PRIVATE_KEY secret is missing.");
  }

  const connection = new Connection(RPC_URL!.trim(), "confirmed");
  let account: Awaited<ReturnType<Connection["getParsedAccountInfo"]>>;
  try {
    account = await connection.getParsedAccountInfo(vote);
  } catch {
    return fail("Could not reach the RPC in the RPC_URL secret.");
  }
  if (account.value?.owner.toBase58() !== VOTE_PROGRAM) {
    fail(
      "VOTE_KEY is not a vote account. Use your validator's vote account address, not its identity.",
    );
  }

  if (payer) {
    const data = account.value!.data;
    const info = "parsed" in data ? data.parsed?.info : undefined;
    if (!info) {
      console.log("Could not read the vote account's keys; skipped the validator-key check.");
    } else {
      const validatorKeys: string[] = [
        info.nodePubkey,
        info.authorizedWithdrawer,
        ...(info.authorizedVoters ?? []).map(
          (v: { authorizedVoter: string }) => v.authorizedVoter,
        ),
      ];
      if (validatorKeys.includes(payer.toBase58())) {
        fail(
          "PRIVATE_KEY is one of your validator's own keys (identity, withdrawer or voter). Use a separate wallet that only pays invoices.",
        );
      }
    }
    console.log(`Bot wallet: ${payer.toBase58()}`);
  }

  console.log(dryRun ? "Dry run: nothing will be sent." : "Live run: due invoices will be paid.");
};

main().catch(() => fail("Unexpected error while checking the secrets."));
