# Yellow Belt submission — PromptRail

> **Note (2026-09-12):** The project is now **Barkeep** ([barkeep.dev](https://barkeep.dev)).
> This document is the Stellar **Journey to Mastery — Yellow Belt** submission
> record and deliberately keeps the original **PromptRail** name throughout,
> because that is the name the work was submitted, deployed and verified under.
> Nothing below has been rewritten to match the new name, and the deployment
> URL below is still live and unchanged.
>
> Moved here out of the README in Phase B of the rename. See
> [docs/SUBMISSION_PACK.md](SUBMISSION_PACK.md) for the paste-ready text that
> Rise In received.

---

## Yellow Belt Requirements

| Requirement                          | Status |
| ------------------------------------ | ------ |
| Soroban smart contract source         | ✅      |
| Cargo workspace at repository root    | ✅      |
| Contract unit tests (13 passing)      | ✅      |
| Contract deployed to Stellar Testnet  | ✅      |
| Contract ID documented in README      | ✅      |
| Contract invoked on-chain (tx hash below) | ✅  |
| Frontend calls the deployed contract  | ✅      |
| Multi-wallet via StellarWalletsKit    | ✅      |
| Wallet options screenshot             | ✅      |
| Wallet not found — distinct error     | ✅      |
| User rejected — distinct error        | ✅      |
| Insufficient balance — distinct error | ✅      |
| Real-time status + contract events    | ✅      |

Carried forward from the White Belt stage:

| Requirement                        | Status |
| ---------------------------------- | ------ |
| Wallet setup (now multi-wallet)    | ✅      |
| Stellar Testnet support            | ✅      |
| Wallet connect                     | ✅      |
| Wallet disconnect                  | ✅      |
| Fetch XLM balance                  | ✅      |
| Display XLM balance                | ✅      |
| Send XLM on Testnet                | ✅      |
| Transaction signing in the wallet  | ✅      |
| Success feedback                   | ✅      |
| Failure feedback                   | ✅      |
| Transaction hash display           | ✅      |
| Stellar explorer link              | ✅      |
| Error handling                     | ✅      |
| Public GitHub repository           | ✅      |
| 10+ meaningful commits             | ✅      |
| Public deployment                  | ✅      |

---

## Development Progress

PromptRail was developed incrementally with meaningful Git commits covering:

1. Project initialization
2. Base dashboard interface
3. Freighter wallet integration
4. Stellar Testnet network validation
5. XLM balance handling
6. Signed XLM Testnet payments
7. Transaction screenshots and testing
8. Project documentation
9. Deployment preparation
10. Soroban workspace scaffolding
11. Payment Tracker contract implementation
12. Contract unit tests
13. Testnet deployment and on-chain verification
14. Frontend integration with the deployed contract
15. Centralized error taxonomy
16. StellarWalletsKit multi-wallet integration
17. Wallet-kit signing for contract calls and balance pre-checks
18. Real-time status polling and contract event feed
19. Wallet options screenshot and README updates

---

## Yellow Belt Learning Outcomes

This project demonstrates practical understanding of:

* Writing Soroban smart contracts in Rust
* Contract storage, TTL management, and data keys
* Contract errors and state-machine guards
* Typed contract events
* Cross-contract calls into the Stellar Asset Contract
* Escrow and authorization (`require_auth`)
* Contract unit testing with the Soroban test environment
* Building, deploying, and invoking a contract on Testnet
* Calling a deployed contract from a React frontend
* Multi-wallet integration with StellarWalletsKit
* Consuming contract events through Soroban RPC in near-real-time
* Typed, user-facing error taxonomies for Web3 failures
* Stellar account architecture
* Stellar public addresses
* Testnet development
* Horizon account queries
* XLM balances
* Stellar transactions
* Payment operations
* XDR serialization
* Wallet-based transaction signing
* Transaction submission
* Transaction hashes
* Blockchain explorer verification
* User-facing Web3 error handling

---

## Challenge

Built for:

**Stellar Journey to Mastery — Yellow Belt**

Network:

**Stellar Testnet**

---
