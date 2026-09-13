# EVM NFT Sniper — V1

A safety-first, configurable NFT public-mint executor for EVM chains. This is a separate project from the Base laptop/token sniper.

## Current milestone

V1 handles a **known NFT mint function** supplied with a full ABI signature. It does not guess arbitrary contract methods. It supports:

- Base, Ethereum, and other EVM chains by reading the actual chain ID from the selected RPC; optional `CHAIN_ID` is only a safety assertion
- Multiple target NFT contract addresses in one run, processed sequentially for deterministic nonce handling
- ERC-721 and ERC-1155 contract verification through ERC-165
- Native-coin mint payments
- ERC-20 mint payments
- Exact automatic ERC-20 approval immediately before execution
- EIP-1559 and legacy dynamic fee policies
- Bounded fee buffering and total native gas-cost caps
- Full read-only preflight, exact transaction simulation, gas estimation, balance checks, and receipt verification
- `DRY_RUN=1` by default and a second `LIVE_TRADING=1` safety switch
- Optional OpenSea free-tier enrichment for collection/NFT metadata; it never authorizes or submits a transaction
- Conservative auto-discovery of common public-mint methods, prices, sale state, and payment-token signals through read-only `eth_call`
- SeaDrop V1 discovery for ERC-721 collections: reads the collection's allowed SeaDrop contracts, validates the active public stage, builds `mintPublic` calldata, and simulates the exact SeaDrop transaction

Secondary-market marketplace sniping is intentionally not in this first milestone. Marketplace orders require separate protocol adapters and should not be mixed into the public-mint executor.

## Safety model

The process refuses to run when any critical value is missing or uncertain:

- Wrong RPC chain ID
- No deployed code at the target contract
- Contract does not confirm ERC-721 or ERC-1155
- Mint signature or arguments do not encode
- Native mint price exceeds the configured maximum
- ERC-20 balance or exact allowance is insufficient
- Approval spender is not the target NFT contract
- Approval gas exceeds its cap
- Mint simulation reverts
- Gas or total operation cost exceeds its cap
- `LIVE_TRADING=1` conflicts with `DRY_RUN=1`

The startup and preflight logs always show the **effective config path**, chain, target contract, payment mode, fee model, gas limit, bounded fee, approval cost, and total cost. A successful estimate is not treated as execution readiness.

## Exact approval flow

For an ERC-20 payment:

1. Read the token decimals and exact payment amount.
2. Read allowance for the target NFT contract.
3. If allowance is short, estimate an approval for exactly the missing required amount.
4. Enforce `maxApprovalGasCostNative`.
5. In live mode, broadcast the exact approval and wait for its receipt.
6. Re-read allowance and require the exact allowance to be present.
7. Simulate the mint using the now-correct allowance.
8. Estimate bounded mint gas, enforce the total cap, and execute once.

No unlimited approval is used. Native-coin mints do not need an ERC-20 approval.

## Setup

All operator settings are environment-variable configurable. `config.json` is optional compatibility fallback only; `.env` takes precedence.

```bash
cp .env.example .env
# edit .env only
npm install
npm run check
npm start
```

Node.js is required. The current Zapia build sandbox may not have Node installed, so runtime testing should be done on Termux, Render, or CI after the files are reviewed.

## Environment configuration

The normal operator setup is intentionally simple, like the Base laptop sniper. Put the contract addresses in one environment variable; comma-separated values activate multiple targets:

```text
RPC_HTTP_URL=
RPC_WS_URL=
TARGET_NFT_CONTRACT_ADDRESS=0xContractOne,0xContractTwo
MINT_FUNCTION=
MINT_ARGS_JSON=
MINT_QUANTITY=1
AUTO_DISCOVER_MINT=1
PAYMENT_MODE=NATIVE
MINT_PRICE_NATIVE=0.001
SNIPER_PRIVATE_KEY=
DRY_RUN=1
LIVE_TRADING=0
```

The remaining safety variables are also simple `.env` values in `.env.example`. `TARGET_NFT_CONTRACT_ADDRESSES` is supported as an alias, but `TARGET_NFT_CONTRACT_ADDRESS` is the primary operator-facing variable. Add `OPENSEA_API_KEY` to enable optional enrichment; leave it empty to run with direct RPC only.

If contracts use different mint functions or prices, use the optional advanced variable. Each target inherits the common environment settings and overrides only what is different:

```text
NFT_TARGETS_JSON=[{"address":"0xContractOne","mintFunction":"mint(address,uint256)","mintArgs":["WALLET_ADDRESS","MINT_QUANTITY"],"mintQuantity":"1","mintPriceNative":"0.001"},{"address":"0xContractTwo","mintFunction":"publicMint(uint256)","mintArgs":["MINT_QUANTITY"],"mintQuantity":"2","mintPriceNative":"0.002"}]
```

`NFT_TARGETS_JSON` takes precedence over `TARGET_NFT_CONTRACT_ADDRESSES` and allows each contract to override the common environment settings.

`targets` is preferred when contracts differ. The bot processes targets sequentially, never concurrently, so one wallet nonce cannot collide with another execution. Supported argument placeholders are `WALLET_ADDRESS`, `MINT_QUANTITY`, `NFT_CONTRACT_ADDRESS`, `PAYMENT_AMOUNT`, and `TOKEN_ID`. Every other argument is passed exactly as configured.

For an ERC-20 payment, set `PAYMENT_MODE=ERC20`, provide `PAYMENT_TOKEN_ADDRESS` and `PAYMENT_AMOUNT`, and optionally `APPROVAL_SPENDER`. V1 only permits the target NFT contract as the approval spender.

### SeaDrop V1

For a standard OpenSea SeaDrop V1 collection, leave `MINT_FUNCTION`, `MINT_ARGS_JSON`, and `MINT_PRICE_NATIVE` empty. Auto-discovery reads `getAllowedSeaDrop()` from the collection, reads each allowed contract's `getPublicDrop(address)` stage, rejects expired or future stages, validates the wallet quantity limit, and creates the exact `mintPublic` call. The transaction target is the discovered allowed SeaDrop contract, while the NFT contract remains the collection target. SeaDrop ERC-20 payment and arbitrary routers remain blocked until a separate exact-spender adapter is verified.

A successful SeaDrop dry run must show `protocol: "SeaDrop"`, an active public stage, a successful exact `eth_call`, and `PREFLIGHT_OK`. A target that is listed as a drop but has no active stage or no readable allowed SeaDrop configuration remains blocked.

## Live-mode checklist

Keep these values until the complete dry run is proven:

```text
DRY_RUN=1
LIVE_TRADING=0
```

Only a dedicated low-balance wallet should be used. The private key belongs in the local `.env` or deployment secret store only; never place it in chat, source code, Git, or a public dashboard.

Before changing to live mode, verify the startup output shows the intended config path, chain ID, NFT contract, mint function, payment, gas cap, and simulation address. Then use:

```text
DRY_RUN=0
LIVE_TRADING=1
```

Live signing is deliberately not enabled by this repository's default files.
