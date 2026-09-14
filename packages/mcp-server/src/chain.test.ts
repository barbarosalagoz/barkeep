import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { contractErrorCode } from "./chain.ts";

/*
 * The shape of a failed transaction's first diagnostic event on Testnet
 * (c75a77fb..., the payee-allowlist refusal): topics [error, Error(Auth,
 * InvalidAction)], data ["failed account authentication with error", <account>,
 * Error(Contract, #3901)]. The contract code sits inside the data vector.
 */
const diagnostic = (topics: xdr.ScVal[], data: xdr.ScVal) =>
  new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });

const contractError = (code: number) => xdr.ScVal.scvError(xdr.ScError.sceContract(code));
const authError = () => xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()));

describe("contractErrorCode", () => {
  it("finds the contract code in the ledger's diagnostic events, not in text", () => {
    const events = [
      diagnostic(
        [xdr.ScVal.scvSymbol("error"), authError()],
        xdr.ScVal.scvVec([xdr.ScVal.scvString("failed account authentication with error"), contractError(3901)])
      ),
    ];

    expect(contractErrorCode(events)).toBe(3901);
    // What the old check did, and why it never matched.
    expect(JSON.stringify(events).match(/Error\(Contract, #\d+\)/)).toBeNull();
  });

  it("returns null when no contract error was recorded", () => {
    expect(contractErrorCode([diagnostic([xdr.ScVal.scvSymbol("error"), authError()], xdr.ScVal.scvVoid())])).toBeNull();
    expect(contractErrorCode([])).toBeNull();
  });
});
