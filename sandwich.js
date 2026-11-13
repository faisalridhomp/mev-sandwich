// sandwich.js — BSC PancakeSwap sandwich MEV bot (prototype)
// Monitors the mempool for large PancakeSwap swaps, estimates sandwich profit,
// and (in live mode) fires a frontrun buy + backrun sell around the victim tx.
//
// DRY-RUN IS THE DEFAULT. Nothing is sent unless --live is passed AND a
// private key is provided via env SANDWICH_PK. The key must be a SEPARATE
// wallet funded with BNB — baw cannot sign at MEV speed (3-8s preview floor).
//
// BSC has no Flashbots relay: ordering is by gas price. The frontrun must
// outbid the victim's gas; the backrun must land right after the victim.
// There is NO guarantee of ordering — this is best-effort.
//
// Usage:
//   node sandwich.js --dry                 (default: detect + log only)
//   node sandwich.js --live                (execute; needs SANDWICH_PK)
//   node sandwich.js --dry --rpc <url> --min-victim-bnb 1 --min-profit-bnb 0.01
//
// Flags:
//   --dry / --live        mode (default dry)
//   --rpc <url>           BSC HTTP RPC (default https://bsc-rpc.publicnode.com)
//   --poll-ms <n>         txpool poll interval in ms (default 1500)
//   --min-victim-bnb <n>  minimum victim swap size in BNB (default 1)
//   --min-profit-bnb <n>  minimum estimated net profit in BNB (default 0.005)
//   --frontrun-bnb <n>    frontrun size in BNB (default 0.1)
//   --gas-bump <n>        gwei to add above victim gas price (default 1)
//   --max-seconds <n>     run duration in seconds (default 0 = forever)

const { ethers } = require('/home/hatch/workspace/ethers.js');

// ---------- config ----------
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const RPC_HTTP = flag('--rpc', 'https://bsc-rpc.publicnode.com');
const POLL_MS = parseInt(flag('--poll-ms', '1500'), 10);
const LIVE = has('--live');
const MIN_VICTIM_BNB = parseFloat(flag('--min-victim-bnb', '1'));
const MIN_PROFIT_BNB = parseFloat(flag('--min-profit-bnb', '0.005'));
const FRONTRUN_BNB = parseFloat(flag('--frontrun-bnb', '0.1'));
const GAS_BUMP_GWEI = parseFloat(flag('--gas-bump', '1'));
const MAX_SECONDS = parseInt(flag('--max-seconds', '0'), 10);

const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'; // verified via router.factory() — was truncated to 39 chars, crashed at startup

// PancakeSwap router swap selectors (4-byte)
const SWAP_SELECTORS = {
  '0x38ed1739': 'swapExactTokensForTokens',   // (amountIn, amountOutMin, path, to, deadline)
  '0x7ff36ab5': 'swapExactETHForTokens',      // (amountOutMin, path, to, deadline) + value
  '0x18cbafe5': 'swapExactTokensForETH',      // (amountIn, amountOutMin, path, to, deadline)
  '0x8803dbee': 'swapTokensForExactTokens',   // (amountOut, amountInMax, path, to, deadline)
  '0xfb3bdb41': 'swapETHForExactTokens',      // (amountOut, path, to, deadline) + value
};

const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
];
const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];
const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const routerIface = new ethers.Interface(ROUTER_ABI);
const pairIface = new ethers.Interface(PAIR_ABI);
const factoryIface = new ethers.Interface(FACTORY_ABI);

let provider, wallet = null, router, factory;
let stats = { seen: 0, swaps: 0, candidates: 0, profitable: 0, sent: 0, errors: 0 };
const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().substr(11, 12)}]`, ...a);

// ---------- helpers ----------
// Constant-product AMM: amount out for amountIn given reserves (0.25% PancakeSwap fee)
function getAmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 9975n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return numerator / denominator;
}

// Simulate a full sandwich on a WBNB<->token pair.
// victimIn: victim's input amount (in tokenIn). tokenIn/tokenOut define direction.
// Returns { profitWei, detail } or null if not profitable.
async function simulateSandwich(pairAddr, tokenIn, tokenOut, victimIn, victimGasPrice) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  const token0 = await pair.token0();
  const inIs0 = tokenIn.toLowerCase() === token0.toLowerCase();
  let reserveIn = inIs0 ? r0 : r1;
  let reserveOut = inIs0 ? r1 : r0;
  reserveIn = BigInt(reserveIn); reserveOut = BigInt(reserveOut);

  // We only sandwich BNB->token (victim buys token with WBNB) for this prototype.
  if (tokenIn.toLowerCase() !== WBNB.toLowerCase()) return null;

  const frontrunIn = ethers.parseEther(FRONTRUN_BNB.toString());
  // 1) frontrun: we buy token with FRONTRUN_BNB
  const frontrunOut = getAmountOut(frontrunIn, reserveIn, reserveOut);
  if (frontrunOut <= 0n) return null;
  const rIn1 = reserveIn + frontrunIn;
  const rOut1 = reserveOut - frontrunOut;
  // 2) victim buys at the worse price
  const victimOut = getAmountOut(victimIn, rIn1, rOut1);
  if (victimOut <= 0n) return null;
  const rIn2 = rIn1 + victimIn;
  const rOut2 = rOut1 - victimOut;
  // 3) backrun: we sell our tokens back for BNB
  const backrunOut = getAmountOut(frontrunOut, rOut2, rIn2);
  const grossProfit = backrunOut - frontrunIn;

  // Gas: frontrun + backrun, ~180k gas each, at victim gas + bump
  const gasPrice = victimGasPrice + ethers.parseUnits(GAS_BUMP_GWEI.toString(), 'gwei');
  const gasCost = gasPrice * 360000n;
  const netProfit = grossProfit - gasCost;
  return {
    profitWei: netProfit,
    grossWei: grossProfit,
    gasWei: gasCost,
    gasPrice,
    frontrunOut,
    victimOut,
    backrunOut,
    detail: `front ${ethers.formatEther(frontrunIn)} BNB -> ${frontrunOut} token; victim out ${victimOut}; back ${ethers.formatEther(backrunOut)} BNB`,
  };
}

async function getPairAddress(tokenA, tokenB) {
  try {
    return await factory.getPair(tokenA, tokenB);
  } catch { return ethers.ZeroAddress; }
}

// Decode a pending router tx into a swap description, or null.
function decodeSwap(tx) {
  if (!tx || !tx.to || tx.to.toLowerCase() !== ROUTER.toLowerCase()) return null;
  if (!tx.data || tx.data.length < 10) return null;
  const sel = tx.data.slice(0, 10).toLowerCase();
  const fn = SWAP_SELECTORS[sel];
  if (!fn) return null;
  try {
    const parsed = routerIface.parseTransaction({ data: tx.data, value: tx.value });
    if (!parsed) return null;
    const a = parsed.args;
    if (fn === 'swapExactTokensForTokens' || fn === 'swapExactTokensForETH') {
      return { fn, amountIn: BigInt(a[0]), amountOutMin: BigInt(a[1]), path: [...a[2]], value: BigInt(tx.value || 0) };
    }
    if (fn === 'swapExactETHForTokens' || fn === 'swapETHForExactTokens') {
      return { fn, amountIn: BigInt(tx.value || 0), amountOutMin: fn === 'swapExactETHForTokens' ? BigInt(a[0]) : null, amountOut: fn === 'swapETHForExactTokens' ? BigInt(a[0]) : null, path: [...a[1]], value: BigInt(tx.value || 0) };
    }
    if (fn === 'swapTokensForExactTokens') {
      return { fn, amountOut: BigInt(a[0]), amountInMax: BigInt(a[1]), path: [...a[2]], value: BigInt(tx.value || 0) };
    }
  } catch { return null; }
  return null;
}

// ---------- execution ----------
async function executeSandwich(victim, swap, sim) {
  if (!wallet) return false;
  // Frontrun: buy token with FRONTRUN_BNB via swapExactETHForTokens
  const path = [WBNB, swap.path[swap.path.length - 1]];
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const gasPrice = sim.gasPrice;
  try {
    const frontTx = await router.swapExactETHForTokens(0, path, wallet.address, deadline, {
      value: ethers.parseEther(FRONTRUN_BNB.toString()),
      gasPrice,
      gasLimit: 250000,
    });
    log(`FRONTRUN sent: ${frontTx.hash} (gas ${ethers.formatUnits(gasPrice, 'gwei')} gwei)`);
    const receipt = await frontTx.wait(1);
    if (receipt.status !== 1) { log('frontrun reverted, aborting backrun'); return false; }
    // Backrun: sell the tokens we just bought back for BNB
    const token = path[1];
    const tok = new ethers.Contract(token, ERC20_ABI, wallet);
    const bal = await tok.balanceOf(wallet.address);
    if (bal <= 0n) { log('no token balance after frontrun, aborting'); return false; }
    const allowance = await tok.allowance(wallet.address, ROUTER);
    if (allowance < bal) {
      const ap = await tok.approve(ROUTER, bal, { gasPrice });
      await ap.wait(1);
    }
    const backTx = await router.swapExactTokensForETH(bal, 0, [token, WBNB], wallet.address, deadline, { gasPrice, gasLimit: 250000 });
    log(`BACKRUN sent: ${backTx.hash}`);
    const br = await backTx.wait(1);
    log(br.status === 1 ? 'backrun confirmed' : 'backrun reverted');
    return br.status === 1;
  } catch (e) {
    log('execute error:', e.shortMessage || e.message || e);
    stats.errors++;
    return false;
  }
}

const seenHashes = new Set();
async function handlePendingTx(tx) {
  if (!tx || !tx.hash) return;
  if (seenHashes.has(tx.hash)) return;
  seenHashes.add(tx.hash);
  if (seenHashes.size > 20000) { const it = seenHashes.values(); for (let i = 0; i < 5000; i++) seenHashes.delete(it.next().value); }
  stats.seen++;
  const swap = decodeSwap(tx);
  if (!swap) return;
  stats.swaps++;

  // Only sandwich BNB -> token buys (victim buys token with BNB).
  // path[0] must be WBNB and path length 2 (direct pair) for this prototype.
  if (!swap.path || swap.path.length !== 2) return;
  if (swap.path[0].toLowerCase() !== WBNB.toLowerCase()) return;
  const token = swap.path[1];
  const victimIn = swap.amountIn;
  const victimBnb = parseFloat(ethers.formatEther(victimIn));
  if (victimBnb < MIN_VICTIM_BNB) return;
  stats.candidates++;

  const victimGasPrice = tx.gasPrice || tx.maxFeePerGas || ethers.parseUnits('0.1', 'gwei');
  const pairAddr = await getPairAddress(WBNB, token);
  if (!pairAddr || pairAddr === ethers.ZeroAddress) return;
  let sim;
  try { sim = await simulateSandwich(pairAddr, WBNB, token, victimIn, victimGasPrice); } catch (e) { return; }
  if (!sim) return;
  const profitBnb = parseFloat(ethers.formatEther(sim.profitWei));
  if (profitBnb < MIN_PROFIT_BNB) return;
  stats.profitable++;

  log(`OPPORTUNITY victim ${tx.hash.slice(0, 18)}... buys ${victimBnb.toFixed(4)} BNB of ${token.slice(0, 10)}... net ~${profitBnb.toFixed(5)} BNB | ${sim.detail}`);
  if (!LIVE) { log('(dry-run: not executing)'); return; }
  const ok = await executeSandwich(tx, swap, sim);
  if (ok) stats.sent++;
}

async function main() {
  log(`sandwich bot starting — mode=${LIVE ? 'LIVE' : 'DRY-RUN'} rpc=${RPC_HTTP} poll=${POLL_MS}ms minVictim=${MIN_VICTIM_BNB} BNB minProfit=${MIN_PROFIT_BNB} BNB frontrun=${FRONTRUN_BNB} BNB`);
  provider = new ethers.JsonRpcProvider(RPC_HTTP);
  if (LIVE) {
    const pk = process.env.SANDWICH_PK;
    if (!pk) { console.error('LIVE mode needs SANDWICH_PK env (separate wallet private key). Exiting.'); process.exit(1); }
    wallet = new ethers.Wallet(pk, provider);
    router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
    factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    const bal = await provider.getBalance(wallet.address);
    log(`live wallet ${wallet.address} balance ${ethers.formatEther(bal)} BNB`);
    if (bal < ethers.parseEther('0.05')) log('WARNING: balance < 0.05 BNB — likely too low to sandwich');
  } else {
    router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
    factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  }

  // Poll txpool_content for full pending transactions.
  // (Public WSS endpoints broadcast pending hashes but return null for
  // getTransaction, so HTTP txpool polling is the working route.)
  let polling = true;
  const poll = async () => {
    while (polling) {
      try {
        const pool = await provider.send('txpool_content', []);
        const pending = pool && pool.pending ? pool.pending : {};
        for (const addr of Object.keys(pending)) {
          const byNonce = pending[addr];
          for (const nonce of Object.keys(byNonce)) {
            const raw = byNonce[nonce];
            // Normalize raw txpool tx into ethers-like shape for decodeSwap
            const tx = {
              hash: raw.hash, to: raw.to, value: raw.value ? BigInt(raw.value) : 0n,
              data: raw.input || '0x',
              gasPrice: raw.gasPrice ? BigInt(raw.gasPrice) : (raw.maxFeePerGas ? BigInt(raw.maxFeePerGas) : 0n),
            };
            await handlePendingTx(tx);
          }
        }
      } catch (e) {
        log('txpool poll error:', e.shortMessage || e.message || e);
        stats.errors++;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  poll().catch((e) => log('poll loop died:', e));
  log('polling txpool_content. Waiting for large PancakeSwap buys...');

  const report = setInterval(() => {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    log(`stats ${el}s: seen=${stats.seen} routerSwaps=${stats.swaps} candidates=${stats.candidates} profitable=${stats.profitable} executed=${stats.sent} errors=${stats.errors}`);
  }, 60000);

  if (MAX_SECONDS > 0) {
    setTimeout(() => {
      polling = false;
      clearInterval(report);
      log(`done. stats: ${JSON.stringify(stats)}`);
      process.exit(0);
    }, MAX_SECONDS * 1000);
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
