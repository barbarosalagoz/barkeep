/*
 * Circle's Facilitator Service on its keyless trial: every call carries a
 * Facilitator-Seller-Proof, an EIP-712 signature from the key behind payTo over
 * the purpose, the method and the hash of the exact body sent.
 * https://developers.circle.com/facilitator-service/sign-seller-proof
 *
 * Returns what came back verbatim -- status, headers, body -- because the
 * point of the spike is to report it.
 */

import { keccak256, toBytes, toHex } from "viem";

import { CHAIN_ID, NETWORK } from "./lib.mjs";

export const CIRCLE_FACILITATOR = "https://api.circle.com/v1/facilitator/x402";

const SELLER_REQUEST = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};

export async function sellerProof(seller, purpose, method, body) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;

  const signature = await seller.signTypedData({
    domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: CHAIN_ID },
    types: SELLER_REQUEST,
    primaryType: "SellerRequest",
    message: {
      purpose,
      method: method.toUpperCase(),
      bodyHash: keccak256(toBytes(body)),
      network: NETWORK,
      payTo: seller.address,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  });

  const envelope = { version: 1, signature, network: NETWORK, payTo: seller.address, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

async function verbatim(response) {
  const raw = await response.text();
  let body = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* not JSON: keep the text */
  }
  const headers = Object.fromEntries(response.headers);
  delete headers["set-cookie"]; // Cloudflare's bot cookie; nothing to report, and not for a log
  return { httpStatus: response.status, headers, body };
}

/** purpose is "verify" or "settle". */
export async function circlePost(seller, purpose, paymentPayload, paymentRequirements) {
  const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements });
  const response = await fetch(`${CIRCLE_FACILITATOR}/${purpose}`, {
    method: "POST",
    headers: { "content-type": "application/json", "Facilitator-Seller-Proof": await sellerProof(seller, purpose, "POST", body) },
    body,
  });
  return verbatim(response);
}

export async function circleStatus(seller, paymentId) {
  const response = await fetch(`${CIRCLE_FACILITATOR}/status/${paymentId}`, {
    headers: { "Facilitator-Seller-Proof": await sellerProof(seller, "status", "GET", "") },
  });
  return verbatim(response);
}
