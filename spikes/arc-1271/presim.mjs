import { encodeDeployData, encodeFunctionData, toHex, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const m = await import("./lib.mjs");
const pc = m.publicClient(), owner = m.account("owner"), seller = m.account("seller"), built = m.compile();
const { data: runtime } = await pc.call({ data: encodeDeployData({ abi: built.abi, bytecode: built.bytecode, args: [owner.address] }) });
const fake = "0x00000000000000000000000000000000ba5ebeef";
const abi = [{ type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", inputs: ["address","address","uint256","uint256","uint256","bytes32","bytes"].map((type, i) => ({ name: `a${i}`, type })), outputs: [] }];
const msg = { from: fake, to: seller.address, value: 1000n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
const typed = { domain: { ...m.USDC_DOMAIN, chainId: m.CHAIN_ID, verifyingContract: m.USDC }, types: { TransferWithAuthorization: [["from","address"],["to","address"],["value","uint256"],["validAfter","uint256"],["validBefore","uint256"],["nonce","bytes32"]].map(([name, type]) => ({ name, type })) }, primaryType: "TransferWithAuthorization", message: msg };
for (const [who, signer] of [["owner", owner], ["stranger", privateKeyToAccount(generatePrivateKey())]]) {
  const signature = await signer.signTypedData(typed);
  try {
    await pc.call({ to: m.USDC, data: encodeFunctionData({ abi, functionName: "transferWithAuthorization", args: [msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, signature] }), stateOverride: [{ address: fake, code: runtime, balance: parseEther("1") }] });
    console.log(who, "-> simulated transfer SUCCEEDS");
  } catch (e) { console.log(who, "-> reverts:", e.shortMessage, e.cause?.reason ?? e.cause?.data ?? ""); }
}
