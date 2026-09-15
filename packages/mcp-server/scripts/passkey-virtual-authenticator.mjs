/*
 * A virtual authenticator playing the human, for rehearsing the passkey path
 * without a real passkey. Chromium's CDP WebAuthn domain creates a software
 * authenticator (ctap2, internal transport, user verification on) that
 * produces genuine WebAuthn assertions -- the thing ARCHITECTURE-v2 §13 noted.
 *
 * Two subcommands, driving the same two pages a human uses:
 *
 *   register <origin>          create a passkey on passkey-register.html,
 *                              print {pub, cid}; keep the credential in a file
 *   sign <origin> <page url>   re-load that credential, open the URL that
 *                              passkey-sign-testnet.mjs prepare printed, click
 *                              Sign, print the assertion JSON
 *
 * The run recorded in deployments/testnet.json (doneTests.passkeyRehearsal):
 *
 *   python3 -m http.server 8001 --directory scripts &        # from the repo root
 *   node scripts/passkey-virtual-authenticator.mjs register http://localhost:8001
 *   PASSKEY_RULE_NAME=passkey-rehearsal PASSKEY_PUBLIC_KEY_HEX=<pub> PASSKEY_CREDENTIAL_ID_HEX=<cid> \
 *     PASSKEY_ORIGIN=http://localhost:8001 npx tsx scripts/add-passkey-rule-testnet.mjs --submit
 *   npx tsx scripts/passkey-sign-testnet.mjs prepare --rule <id> --hours 1     # swap :8000 for :8001 in the URL
 *   node scripts/passkey-virtual-authenticator.mjs sign http://localhost:8001 '<url>'
 *   npx tsx scripts/passkey-sign-testnet.mjs submit --assertion '<assertion>'
 *   npx tsx scripts/remove-context-rule-testnet.mjs <id>
 *
 * Needs playwright-core and its Chromium, which are NOT dependencies of this
 * repo: point PLAYWRIGHT_CORE at an installed copy (a directory containing
 * index.js). The credential file holds a throwaway private key; it is written
 * to the state directory and is worth deleting after.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../src/state.ts";

const [cmd, origin, url] = process.argv.slice(2);
const STATE = join(stateDir(), "virtual-authenticator.json");

const fail = (msg) => {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
};
const pwPath = process.env.PLAYWRIGHT_CORE ?? fail("PLAYWRIGHT_CORE=<path to playwright-core> is required; it is not a dependency of this repo");
const { chromium } = createRequire(import.meta.url)(join(pwPath, "index.js"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

try {
  if (cmd === "register" && origin) {
    await page.goto(`${origin}/passkey-register.html`);
    await page.click("#create");
    await page.waitForSelector("#out:not([hidden])", { timeout: 20000 });
    const pub = await page.textContent("#pub");
    const cid = await page.textContent("#cid");
    await page.click("#test");
    await page.waitForSelector("#testOut:not([hidden])", { timeout: 20000 });
    const flags = await page.textContent("#flags");
    const verdict = await page.textContent("#verdict");
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(STATE, JSON.stringify(credentials));
    console.log(JSON.stringify({ pub, cid, flags, verdict, credentialFile: STATE }));
  } else if (cmd === "sign" && origin && url) {
    if (!existsSync(STATE)) fail(`no credential at ${STATE}; run register first`);
    for (const c of JSON.parse(readFileSync(STATE, "utf8"))) {
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: c });
    }
    await page.goto(url);
    await page.waitForSelector("#what:not([hidden])", { timeout: 10000 });
    await page.click("#sign");
    await page.waitForSelector("#out:not([hidden])", { timeout: 20000 });
    const assertion = JSON.parse(await page.textContent("#json"));
    const verdict = await page.textContent("#verdict");
    const local = await page.textContent("#local");
    const flags = await page.textContent("#flags");
    console.log(JSON.stringify({ assertion, verdict, local, flags }));
  } else if (cmd === "forget") {
    if (existsSync(STATE)) unlinkSync(STATE);
    console.log(`removed ${STATE}`);
  } else {
    fail("usage: register <origin> | sign <origin> <page url> | forget");
  }
} catch (e) {
  // Runs in the page, where document exists.
  // eslint-disable-next-line no-undef
  const shown = await page.evaluate(() => [...document.querySelectorAll(".bad")].map((n) => n.textContent).filter(Boolean).join(" | ")).catch(() => "");
  console.error(`FAILED: ${e.message}${shown ? ` | page: ${shown}` : ""}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
