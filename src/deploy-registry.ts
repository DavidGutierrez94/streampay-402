import { pub, wallet, txUrl, addrUrl } from "./chain";
import { registryAbi, registryBytecode } from "./registry";
const hash = await wallet(process.env.PAYER_KEY!).deployContract({ abi: registryAbi, bytecode: registryBytecode });
const r = await pub.waitForTransactionReceipt({ hash });
console.log("ServiceRegistry deployed:", r.contractAddress, "\ndeploy tx:", txUrl(hash), "\nexplorer:", addrUrl(r.contractAddress!));
const env = await Bun.file(".env").text();
await Bun.write(".env", env.replace(/^REGISTRY_ADDRESS=.*\n?/m, "") + `REGISTRY_ADDRESS=${r.contractAddress}\n`);
