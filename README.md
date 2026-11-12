# Sandwich MEV Bot (BSC / PancakeSwap) — Prototype

## What it does
Monitors the BSC mempool for large PancakeSwap buys (BNB -> token), simulates a
sandwich (frontrun buy + backrun sell) on the pair's constant-product reserves,
and — in live mode only — fires the two transactions around the victim.

## How it works
- **Mempool source:** HTTP `txpool_content` polling (default every 1500ms).
  Public BSC WebSocket endpoints broadcast pending hashes but return `null`
  for `eth_getTransactionByHash` on pending txs, so WSS + getTransaction does
  NOT work. `txpool_content` returns the full pending tx objects (to, input,
  gasPrice, value) and is confirmed working on `bsc-rpc.publicnode.com`.
  Official dataseed WSS endpoints don't accept WebSocket connections at all.
- **Detection:** filters for PancakeSwap router
  `0x10ED43C718714eb63d5aA57B78B54704E256024E`, decodes the 5 common swap
  selectors, keeps only direct WBNB -> token buys with `path.length == 2`
  and victim size >= `--min-victim-bnb`.
- **Simulation:** constant-product AMM math (0.25% fee) on live pair reserves:
  frontrun -> victim -> backrun. Net profit = backrun proceeds - frontrun cost
  - gas (frontrun + backrun, ~360k gas at victim gas + bump).
- **Execution (live only):** frontrun `swapExactETHForTokens`, wait 1 conf,
  approve + backrun `swapExactTokensForETH`. Gas price = victim gas + bump.

## Verified test (dry-run, 60s, 2026-11-11)
- Seen 11,719 pending txs, 3 PancakeSwap router swaps detected, 0 candidates
  (all below the 0.5 BNB / direct-pair filter), 0 errors. Pipeline works.

## Usage
```
node sandwich.js --dry                 # detect + log only (default)
node sandwich.js --live                # execute; needs SANDWICH_PK env
node sandwich.js --dry --rpc <url> --min-victim-bnb 1 --min-profit-bnb 0.01
```
Flags: `--rpc`, `--poll-ms`, `--min-victim-bnb`, `--min-profit-bnb`,
`--frontrun-bnb`, `--gas-bump`, `--max-seconds`.

## What live mode needs (and why it's hard)
1. **SANDWICH_PK** — a SEPARATE wallet private key, funded with BNB.
   baw cannot sign at MEV speed (3-8s preview floor). The key lives in the
   environment, never in a file.
2. **Capital** — frontrun size + gas. Bigger frontrun = bigger price move =
   bigger profit, but bigger risk.
3. **Ordering is NOT guaranteed on BSC.** There is no Flashbots relay.
   Validators order by gas price. The frontrun outbids the victim; the
   backrun must land right after. A competing bot or a reordered block can
   flip the profit into a loss.
4. **Latency** — txpool polling every 1.5s vs BSC's 3s blocks leaves ~1-2
   chances to catch a victim tx. A paid node / private mempool feed would
   be faster and more reliable.

## Files
- `sandwich.js` — the bot
- `diag.js` — WSS/getTransaction diagnostic (shows publicnode WSS returns
  null for pending txs; dataseed WSS doesn't connect)
