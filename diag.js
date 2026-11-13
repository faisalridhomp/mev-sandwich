const { ethers } = require('ethers');
const WSS = process.argv[2] || 'wss://bsc.publicnode.com';
(async () => {
  const p = new ethers.WebSocketProvider(WSS);
  try {
    const net = await p.getNetwork();
    console.log('network:', net.chainId, net.name);
  } catch (e) { console.log('getNetwork FAILED:', e.shortMessage || e.message); }
  let got = 0, fetched = 0, decoded = 0;
  const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
  p.on('pending', async (h) => {
    got++;
    if (got > 5) return;
    try {
      const tx = await p.getTransaction(h);
      if (!tx) { console.log('hash', h.slice(0,12), '-> getTransaction null'); return; }
      fetched++;
      const isRouter = tx.to && tx.to.toLowerCase() === ROUTER.toLowerCase();
      console.log('hash', h.slice(0,12), 'to', (tx.to||'').slice(0,10), 'router?', isRouter, 'data', (tx.data||'').slice(0,10));
      if (isRouter) decoded++;
    } catch (e) { console.log('hash', h.slice(0,12), '-> getTransaction ERROR:', e.shortMessage || e.message); }
  });
  setTimeout(() => { console.log(`done: got=${got} fetched=${fetched} router=${decoded}`); process.exit(0); }, 20000);
})();
