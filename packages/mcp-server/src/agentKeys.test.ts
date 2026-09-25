import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { AgentKeys, agentKeyDir } from "./agentKeys.ts";
import { Store, storedText } from "./state.ts";

/*
 * Per-tab agent keys, offline. That a fresh key really signs for its own rule
 * on chain, and that close_tab leaves the chain refusing it, is a Testnet
 * done-test, not this file.
 */

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const savedEnv = { state: process.env.BARKEEP_STATE_DIR, keys: process.env.BARKEEP_AGENT_KEY_DIR };

afterEach(() => {
  for (const [name, value] of [
    ["BARKEEP_STATE_DIR", savedEnv.state],
    ["BARKEEP_AGENT_KEY_DIR", savedEnv.keys],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("where agent keys live", () => {
  it("defaults to a directory next to the state directory, never inside it", () => {
    const parent = tmp("barkeep-parent-");
    process.env.BARKEEP_STATE_DIR = join(parent, "state");
    delete process.env.BARKEEP_AGENT_KEY_DIR;

    expect(agentKeyDir()).toBe(join(parent, "state-agent-keys"));
  });

  it("can be set explicitly", () => {
    process.env.BARKEEP_AGENT_KEY_DIR = "/somewhere/else";
    expect(agentKeyDir()).toBe("/somewhere/else");
  });

  it("leaves the state directory free of key material after a key is made", () => {
    const parent = tmp("barkeep-parent-");
    process.env.BARKEEP_STATE_DIR = join(parent, "state");
    delete process.env.BARKEEP_AGENT_KEY_DIR;

    const store = new Store(process.env.BARKEEP_STATE_DIR);
    const agent = new AgentKeys().create();
    store.appendReceipt({ tabId: "tab_x", at: "1", kind: "open", tx: "abc" });

    const written = storedText(store.dir);
    expect(written).not.toContain(agent.secret());
    expect(written).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });
});

describe("a tab's own key", () => {
  it("is written as one mode-600 file, named by its public key, in a mode-700 directory", () => {
    const keys = new AgentKeys(join(tmp("barkeep-keys-"), "agents"));
    const agent = keys.create();
    const file = join(keys.dir, `${agent.publicKey()}.json`);

    expect(statSync(keys.dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(keys.dir)).toEqual([`${agent.publicKey()}.json`]);
    expect(keys.load(agent.publicKey()).secret()).toBe(agent.secret());
  });

  it("is different for every tab", () => {
    const keys = new AgentKeys(tmp("barkeep-keys-"));
    const a = keys.create();
    const b = keys.create();

    expect(a.publicKey()).not.toBe(b.publicKey());
    expect(readdirSync(keys.dir)).toHaveLength(2);
  });

  it("is destroyed: the file is gone and the key can no longer be loaded", () => {
    const keys = new AgentKeys(tmp("barkeep-keys-"));
    const agent = keys.create();
    const file = join(keys.dir, `${agent.publicKey()}.json`);

    expect(keys.destroy(agent.publicKey())).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(() => keys.load(agent.publicKey())).toThrow();
    expect(keys.destroy(agent.publicKey())).toBe(false);
  });

  it("refuses a name that is not a public key, so no path can be passed in", () => {
    const keys = new AgentKeys(tmp("barkeep-keys-"));

    expect(() => keys.has("../../etc/passwd")).toThrow(/not an agent public key/);
    expect(() => keys.destroy("SOMETHING")).toThrow(/not an agent public key/);
  });

  it("refuses a file that holds a different key than its name says", () => {
    const keys = new AgentKeys(tmp("barkeep-keys-"));
    const agent = keys.create();
    const other = Keypair.random();
    const file = join(keys.dir, `${other.publicKey()}.json`);

    // A file for `other` that actually holds `agent`'s secret.
    rmSync(join(keys.dir, `${agent.publicKey()}.json`));
    writeFileSync(file, JSON.stringify({ secret: agent.secret() }), { mode: 0o600 });

    expect(() => keys.load(other.publicKey())).toThrow(/holds a different key/);
    expect(readFileSync(file, "utf8")).toContain(agent.secret());
  });
});

describe("which key signs for a tab", () => {
  const shared = Keypair.random();
  const legacy = () => shared;

  it("uses the tab's own key when there is one", () => {
    const keys = new AgentKeys(tmp("barkeep-keys-"));
    const agent = keys.create();

    const signer = keys.keyFor({ tabId: "tab_new", agentPublicKey: agent.publicKey() }, legacy);
    expect(signer.publicKey()).toBe(agent.publicKey());
  });

  it("falls back to the shared key only for a tab opened with it", () => {
    const keys = new AgentKeys(tmp("barkeep-keys-"));

    const signer = keys.keyFor({ tabId: "tab_old", agentPublicKey: shared.publicKey() }, legacy);
    expect(signer.publicKey()).toBe(shared.publicKey());
  });

  it("refuses a tab whose own key has been destroyed, rather than signing with another", () => {
    const keys = new AgentKeys(tmp("barkeep-keys-"));
    const agent = keys.create();
    keys.destroy(agent.publicKey());

    expect(() => keys.keyFor({ tabId: "tab_closed", agentPublicKey: agent.publicKey() }, legacy)).toThrow(
      /no key for it is left/
    );
  });
});
