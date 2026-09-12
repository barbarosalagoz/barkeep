/*
 * The auth digest for smart accounts built on stellar-accounts 4529d70
 * (OpenZeppelin/stellar-contracts#868), the AuthDigestPreimage scheme.
 *
 * authDigest.ts is the 0.7.2 scheme and stays: the deployed 0.7.2 account and
 * its recorded done-tests depend on it. The two differ in exactly one way that
 * matters -- this one binds the account address:
 *
 *   0.7.2    sha256(signature_payload || context_rule_ids.to_xdr())
 *   4529d70  sha256(AuthDigestPreimage { account, signature_payload,
 *                                        context_rule_ids }.to_xdr())
 *
 * External signers sign the digest. Delegated signers authorise the preimage
 * itself: an extra auth entry, for the delegate, whose root invocation is
 * __check_auth on the account with the preimage map as its only argument.
 * Simulation never returns that entry; see delegateAuthInvocation.
 *
 * Checked three ways: contracts/barkeep-v09-smart-account/src/test.rs emits
 * vectors that authDigestPreimage.test.ts asserts, and the deployed account's
 * auth_digest(preimage) view is simulated against this module on Testnet by
 * scripts/v09-client-flow-testnet.mjs.
 *
 * AuthPayload and Signer are unchanged by #868, so buildAuthPayload and
 * signerToScVal are reused from authDigest.ts.
 */

import { Address, hash, xdr } from "@stellar/stellar-sdk";

/**
 * AuthDigestPreimage as an ScVal.
 *
 * A #[contracttype] struct is a map keyed by field-name symbols, and the host
 * rejects a map whose keys are not sorted. Sorted is account,
 * context_rule_ids, signature_payload -- not the declaration order, which puts
 * signature_payload second.
 */
export function authDigestPreimageScVal(
  account: string,
  signaturePayload: Uint8Array,
  contextRuleIds: readonly number[]
): xdr.ScVal {
  if (signaturePayload.length !== 32) {
    throw new RangeError(`signature payload must be 32 bytes, got ${signaturePayload.length}`);
  }
  for (const id of contextRuleIds) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
      throw new RangeError(`context rule id must be a u32, got ${id}`);
    }
  }

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("account"),
      val: Address.fromString(account).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signature_payload"),
      val: xdr.ScVal.scvBytes(Buffer.from(signaturePayload)),
    }),
  ]);
}

/** The digest an External signer signs on a 4529d70 account. */
export function authDigestV09(
  account: string,
  signaturePayload: Uint8Array,
  contextRuleIds: readonly number[]
): Buffer {
  return hash(authDigestPreimageScVal(account, signaturePayload, contextRuleIds).toXDR());
}

/**
 * The invocation a Delegated signer must authorise: __check_auth on the
 * account, with the preimage as its single argument.
 *
 * The host's require_auth_for_args((preimage,)) inside do_check_auth runs only
 * when __check_auth executes, which recording-mode simulation never does, so
 * simulation cannot report it. The client builds this entry itself.
 */
export function delegateAuthInvocation(
  account: string,
  signaturePayload: Uint8Array,
  contextRuleIds: readonly number[]
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(account).toScAddress(),
        functionName: "__check_auth",
        args: [authDigestPreimageScVal(account, signaturePayload, contextRuleIds)],
      })
    ),
    subInvocations: [],
  });
}
