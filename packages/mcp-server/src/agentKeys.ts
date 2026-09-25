/*
 * Per-tab agent session keys.
 *
 * open_tab makes a fresh ed25519 key for each tab, and close_tab destroys it
 * once the tab's rule is gone from the chain. A leaked key therefore reaches
 * one tab, not every tab the server ever opened.
 *
 * Where: one file per key, named by its public key, mode 600, in a mode-700
 * directory that is NOT the state directory. The state directory holds public
 * values only (state.ts) and stays that way; this directory holds nothing but
 * agent keys. Location, in order of preference:
 *   1. $BARKEEP_AGENT_KEY_DIR
 *   2. <state directory>-agent-keys, e.g. ~/.local/state/barkeep-agent-keys
 *
 * What an agent key can do: sign for its own tab's context rule, which the
 * chain limits to the rule's cap, payees and expiry. The admin key, which can
 * change rules, never comes here; it is still read from the environment.
 *
 * Destroying overwrites the file, then removes it. On a copy-on-write
 * filesystem or an SSD that is not forensic erasure: read it as "this server
 * can no longer sign for the tab". What ends the tab is the rule's removal on
 * chain, which close_tab does first.
 *
 * Tabs opened before this module existed used one shared key from
 * BARKEEP_AGENT_SECRET. They have no file here, and keyFor falls back to that
 * key for them only.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { stateDir } from "./state.ts";

export function agentKeyDir(): string {
  const explicit = process.env.BARKEEP_AGENT_KEY_DIR;
  if (explicit) return explicit;

  const state = stateDir();
  return join(dirname(state), `${basename(state)}-agent-keys`);
}

export class AgentKeys {
  readonly dir: string;

  constructor(dir: string = agentKeyDir()) {
    this.dir = dir;
  }

  private file(publicKey: string): string {
    // The name is the public key; refuse anything else so no path can be smuggled in.
    if (!StrKey.isValidEd25519PublicKey(publicKey)) throw new Error(`not an agent public key: ${publicKey}`);
    return join(this.dir, `${publicKey}.json`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  /** A fresh key, written before it is used anywhere. Never overwrites an existing file. */
  create(): Keypair {
    this.ensureDir();
    const agent = Keypair.random();
    writeFileSync(this.file(agent.publicKey()), `${JSON.stringify({ secret: agent.secret() })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return agent;
  }

  has(publicKey: string): boolean {
    return existsSync(this.file(publicKey));
  }

  load(publicKey: string): Keypair {
    const { secret } = JSON.parse(readFileSync(this.file(publicKey), "utf8")) as { secret: string };
    const agent = Keypair.fromSecret(secret);
    if (agent.publicKey() !== publicKey) throw new Error(`agent key file for ${publicKey} holds a different key`);
    return agent;
  }

  /** Overwrites, then removes. True if a key was there. */
  destroy(publicKey: string): boolean {
    const file = this.file(publicKey);
    if (!existsSync(file)) return false;
    writeFileSync(file, "0".repeat(512), { mode: 0o600 });
    rmSync(file);
    return true;
  }

  /**
   * The key that signs for a tab: its own file, or, for a tab opened before
   * per-tab keys, the shared key from the environment if it matches.
   */
  keyFor(tab: { tabId: string; agentPublicKey: string }, legacy: () => Keypair): Keypair {
    if (this.has(tab.agentPublicKey)) return this.load(tab.agentPublicKey);

    const shared = legacy();
    if (shared.publicKey() !== tab.agentPublicKey) {
      throw new Error(
        `${tab.tabId} was opened for agent ${tab.agentPublicKey}, and no key for it is left: ` +
          "its file is gone (closed or destroyed) and the shared key does not match"
      );
    }
    return shared;
  }
}
