/*
 * Read-only access to a contract: simulate an invocation and return its value.
 *
 * Nothing here signs. A simulation still needs a source account that exists
 * on the network, so the reader takes one PUBLIC key; the deployer's from
 * deployments/testnet.json will do, and holding it grants nothing. The MCP
 * server's Chain wraps this same reader for its reads and adds signing and
 * submission on top; the bill uses the reader alone.
 */

import { BASE_FEE, Operation, TransactionBuilder, rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";

export interface Invocation {
  contract: string;
  fn: string;
  args: xdr.ScVal[];
}

/** What the read functions need: a way to simulate one call. */
export interface ChainRead {
  read(invocation: Invocation): Promise<unknown>;
}

export interface TabReaderConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** A funded account's public key, used only as the simulation's source. */
  sourceAccount: string;
}

export class TabReader implements ChainRead {
  readonly server: rpc.Server;
  private readonly cfg: TabReaderConfig;

  constructor(cfg: TabReaderConfig) {
    this.cfg = cfg;
    this.server = new rpc.Server(cfg.rpcUrl);
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /** Simulate and return the value, without touching the ledger. */
  async read({ contract, fn, args }: Invocation): Promise<unknown> {
    const source = await this.server.getAccount(this.cfg.sourceAccount);
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
}
