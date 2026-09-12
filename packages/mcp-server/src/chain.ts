/*
 * Talking to the smart account on chain.
 *
 * This is the machinery scripts/tab-lifecycle-testnet.mjs proved out, lifted
 * into a module so the MCP tools use exactly the same path rather than a second
 * implementation that drifts. Two things in here are not obvious and both cost
 * a debugging round when they were first hit:
 *
 * 1. Recording-mode simulation does not run `__check_auth`. The first
 *    simulation only records which authorisations would be needed, so a
 *    transfer that the policy will reject sails through it. The rejection
 *    appears only on the SECOND simulation, once signed auth entries are
 *    attached. A client that stops after the first simulation reports success
 *    for a transfer the chain is about to refuse.
 *
 * 2. A rejected invocation returns no transactionData, so it cannot be
 *    assembled and submitted, and the refusal would never reach the ledger.
 *    `force` exists to build the auth entry by hand and reuse a known-good
 *    footprint, so a refusal can be recorded rather than only observed.
 */

import {
  Address, BASE_FEE, Keypair, Operation, TransactionBuilder,
  authorizeEntry, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";

import { authDigest, buildAuthPayload } from "./authDigest.ts";
import { rawEd25519Key } from "./keys.ts";

export interface Invocation {
  contract: string;
  fn: string;
  args: xdr.ScVal[];
}

export interface SendResult {
  ok: boolean;
  /** Where it ended: the second simulation, submission, or the ledger. */
  stage: "simulation" | "send" | "execution" | "timeout";
  hash?: string;
  /** `Error(Contract, #NNNN)` when the chain refused it. */
  error: string | null;
  returnValue?: unknown;
  footprint?: { sorobanData: xdr.SorobanTransactionData; fee: string };
}

export interface ChainConfig {
  rpcUrl: string;
  networkPassphrase: string;
  smartAccount: string;
  verifierEd25519: string;
}

export class Chain {
  readonly server: rpc.Server;
  private readonly cfg: ChainConfig;
  /** Pays the transaction fee and sequence number; never authorises anything. */
  private readonly submitter: Keypair;

  constructor(cfg: ChainConfig, submitter: Keypair) {
    this.cfg = cfg;
    this.submitter = submitter;
    this.server = new rpc.Server(cfg.rpcUrl);
  }

  get network(): string {
    return this.cfg.networkPassphrase;
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /** Read-only call: simulate and return the value, without touching the ledger. */
  async read({ contract, fn, args }: Invocation): Promise<unknown> {
    const source = await this.server.getAccount(this.submitter.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`);
    return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
  }

  /** The signer callback: sign the auth digest, not the raw payload. */
  private signAs(kp: Keypair, contextRuleId: number) {
    const signer = {
      kind: "external" as const,
      verifier: this.cfg.verifierEd25519,
      keyData: rawEd25519Key(kp.publicKey()),
    };

    return async (_preimage: xdr.HashIdPreimage, payload: Buffer) => ({
      signatureScVal: buildAuthPayload(
        [{ signer, signature: kp.sign(authDigest(payload, [contextRuleId])) }],
        [contextRuleId]
      ),
    });
  }

  private unsignedAuthEntry({ contract, fn, args }: Invocation): xdr.SorobanAuthorizationEntry {
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(this.cfg.smartAccount).toScAddress(),
          nonce: new xdr.Int64(BigInt(Math.floor(Math.random() * 2 ** 47))),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(contract).toScAddress(),
            functionName: fn,
            args,
          })
        ),
        subInvocations: [],
      }),
    });
  }

  private async settle(hash: string): Promise<SendResult> {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      const got = await this.server.getTransaction(hash);
      if (got.status === "NOT_FOUND") continue;

      let error: string | null = null;
      if (got.status !== "SUCCESS") {
        const diag = JSON.stringify(
          (got as { diagnosticEventsXdr?: unknown }).diagnosticEventsXdr ?? got.resultMetaXdr ?? ""
        );
        error = diag.match(/Error\(Contract, #\d+\)/)?.[0] ?? null;
      }

      const retval = (got as { returnValue?: xdr.ScVal }).returnValue;

      return {
        ok: got.status === "SUCCESS",
        stage: "execution",
        hash,
        error,
        returnValue: retval ? scValToNative(retval) : undefined,
      };
    }

    return { ok: false, stage: "timeout", hash, error: "transaction not observed in 60s" };
  }

  /**
   * Build, authorise, submit.
   *
   * @param force reuse this footprint and submit even when the second
   *   simulation fails, so a refusal is recorded on chain instead of only seen
   *   locally. See the note at the top of this file.
   */
  async send(
    invocation: Invocation,
    opts: {
      signWith?: Keypair;
      contextRuleId?: number;
      force?: { sorobanData: xdr.SorobanTransactionData; fee: string };
    } = {}
  ): Promise<SendResult> {
    const { signWith, contextRuleId, force } = opts;

    const build = async (
      auth?: xdr.SorobanAuthorizationEntry[],
      sorobanData?: xdr.SorobanTransactionData,
      fee?: string
    ) => {
      const source = await this.server.getAccount(this.submitter.publicKey());
      const b = new TransactionBuilder(source, {
        fee: fee ?? BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: invocation.contract,
            function: invocation.fn,
            args: invocation.args,
            ...(auth ? { auth } : {}),
          })
        )
        .setTimeout(60);

      if (sorobanData) b.setSorobanData(sorobanData);
      return b.build();
    };

    const validUntil = (await this.latestLedger()) + 60;
    const probe = await this.server.simulateTransaction(await build());

    if (rpc.Api.isSimulationError(probe)) {
      // Reached when the invocation itself is bad, not when auth will fail.
      if (!force || !signWith || contextRuleId === undefined) {
        return { ok: false, stage: "simulation", error: probe.error };
      }

      const entry = await authorizeEntry(
        this.unsignedAuthEntry(invocation),
        this.signAs(signWith, contextRuleId),
        validUntil,
        this.cfg.networkPassphrase
      );
      return this.submit(await build([entry], force.sorobanData, force.fee), probe.error);
    }

    const signed = await Promise.all(
      (probe.result?.auth ?? []).map((entry) =>
        entry.credentials().switch().name === "sorobanCredentialsAddress" &&
        signWith &&
        contextRuleId !== undefined
          ? authorizeEntry(entry, this.signAs(signWith, contextRuleId), validUntil, this.cfg.networkPassphrase)
          : entry
      )
    );

    const withAuth = await build(signed.length ? signed : undefined);
    const sim = await this.server.simulateTransaction(withAuth);

    // Where policy and context-rule rejections actually surface.
    if (rpc.Api.isSimulationError(sim)) {
      if (!force) return { ok: false, stage: "simulation", error: sim.error };
      return this.submit(
        await build(signed.length ? signed : undefined, force.sorobanData, force.fee),
        sim.error
      );
    }

    const tx = rpc.assembleTransaction(withAuth, sim).build();
    const out = await this.submit(tx, null);

    if (out.ok) {
      out.footprint = {
        sorobanData: tx.toEnvelope().v1().tx().ext().sorobanData(),
        fee: tx.fee,
      };
    }
    return out;
  }

  private async submit(
    tx: ReturnType<TransactionBuilder["build"]>,
    simulationError: string | null
  ): Promise<SendResult> {
    tx.sign(this.submitter);

    let sent;
    try {
      sent = await this.server.sendTransaction(tx);
    } catch (e) {
      return { ok: false, stage: "send", error: String(e) };
    }

    if (sent.status === "ERROR") {
      return { ok: false, stage: "send", hash: sent.hash, error: JSON.stringify(sent.errorResult) };
    }

    const settled = await this.settle(sent.hash);
    return { ...settled, error: settled.error ?? simulationError };
  }
}

export const explorerTx = (hash: string): string =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`;
