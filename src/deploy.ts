// Deploys StreamEscrow v2 only. Spend caps on chain live in StreamEscrowV3, which is not deployed — see README.
import { pub, wallet, abi, bytecode, addrUrl, txUrl } from "./chain";
const w = wallet(process.env.PAYER_KEY!);
const hash = await w.deployContract({ abi, bytecode });
const r = await pub.waitForTransactionReceipt({ hash });
console.log("StreamEscrow deployed:", r.contractAddress);
console.log("deploy tx:", txUrl(hash));
console.log("explorer:", addrUrl(r.contractAddress!));
const env = await Bun.file(".env").text();
await Bun.write(".env", env.replace(/^ESCROW_ADDRESS=.*\n?/m, "") + `ESCROW_ADDRESS=${r.contractAddress}\n`);
