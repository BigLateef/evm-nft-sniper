# Build status

## Milestone 1 — complete in workspace

- Separate `evm-nft-sniper/` project created; existing `laptop-sniper/` was not modified.
- Config path is resolved and printed at startup.
- EVM chain ID is checked against the connected RPC.
- One or many target contract addresses are accepted through environment variables; targets are processed sequentially to keep nonce handling deterministic.
- `NFT_TARGETS_JSON` supports per-contract mint functions, quantities, prices, and payment settings without editing config files.
- Optional OpenSea enrichment was added; it is metadata-only and never replaces direct RPC verification or authorizes execution.
- Conservative auto-discovery now tests common public-mint signatures with read-only `eth_call`; ambiguous contracts remain blocked.
- Target contract code and ERC-721/ERC-1155 ERC-165 support are verified.
- Mint ABI must be supplied explicitly; the bot never guesses a function.
- Native and ERC-20 payment paths are scaffolded.
- ERC-20 exact auto-approval is implemented for the NFT contract only.
- EIP-1559 and legacy fee handling is dynamic with bounded buffering.
- Approval-gas, mint-gas, and total-cost caps are enforced.
- Dry-run/live dual gates, exact simulation, balance checks, receipt checks, and health endpoint are implemented.

## Not yet enabled

- Secondary-market marketplace adapters.
- Automatic mint-function discovery.
- Permit/Permit2 atomic approval paths.
- Runtime test execution in this sandbox because Node.js/npm are not available here.
- Live wallet configuration or transaction broadcasting.

## Next verified milestone

Install dependencies on Termux, Render, or CI; run `npm run check`; configure one known test NFT contract and simulation address; then run a read-only dry-run before any live mode is considered.
