const https = require('https');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const MIN_GAP = parseFloat(process.env.MIN_GAP || '2.0');      // minimum KES gap to alert
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || '60000'); // ms between scans
const COINS = ['USDT', 'BTC', 'ETH'];
// ──────────────────────────────────────────────────────────

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ Missing TELEGRAM_TOKEN or CHAT_ID environment variables');
  process.exit(1);
}

let lastAlertTime = {};
let scanCount = 0;
let opportunitiesFound = 0;

// ─── HTTP HELPER ──────────────────────────────────────────
function post(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(d); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── FETCH P2P DATA ───────────────────────────────────────
function fetchP2P(tradeType, coin) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      asset: coin,
      fiat: 'KES',
      merchantCheck: false,
      page: 1,
      payTypes: [],
      publisherType: null,
      rows: 5,
      tradeType: tradeType
    });

    const options = {
      hostname: 'p2p.binance.com',
      path: '/bapi/c2c/v2/friendly/c2c/adv/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://p2p.binance.com',
        'Referer': 'https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'TE': 'trailers'
      }
    };

    const req = https.request(options, res => {
      const chunks = [];

      // handle gzip/deflate
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'br') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (res.headers['content-encoding'] === 'deflate') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createInflate());
      }

      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try {
          const d = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(d);
          if (parsed.data && parsed.data.length > 0) {
            resolve(parsed.data);
          } else {
            console.log(`ℹ️  ${tradeType} ${coin}: ${parsed.message || 'empty response'}`);
            resolve([]);
          }
        } catch(e) {
          resolve([]);
        }
      });
      stream.on('error', () => resolve([]));
    });

    req.on('error', (e) => {
      console.log(`⚠️  Request error for ${coin}: ${e.message}`);
      resolve([]);
    });
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

// ─── SEND TELEGRAM MESSAGE ────────────────────────────────
async function sendTelegram(message) {
  try {
    await post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('✅ Telegram message sent');
  } catch(e) {
    console.error('❌ Telegram send failed:', e.message);
  }
}

// ─── FORMAT NUMBER ────────────────────────────────────────
function fmt(n, decimals = 2) {
  return n.toLocaleString('en-KE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

// ─── SCAN ONE COIN ────────────────────────────────────────
async function scanCoin(coin) {
  const [sellAds, buyAds] = await Promise.all([
    fetchP2P('SELL', coin),  // people selling crypto → you BUY from cheapest
    fetchP2P('BUY', coin)    // people buying crypto → you SELL to highest
  ]);

  if (!sellAds.length || !buyAds.length) {
    console.log(`⚠️  No data for ${coin}/KES`);
    return null;
  }

  const sellers = sellAds
    .map(ad => ({
      price: parseFloat(ad.adv.price),
      trader: ad.advertiser.nickName,
      min: parseFloat(ad.adv.minSingleTransAmount),
      max: parseFloat(ad.adv.maxSingleTransAmount),
    }))
    .sort((a, b) => a.price - b.price);

  const buyers = buyAds
    .map(ad => ({
      price: parseFloat(ad.adv.price),
      trader: ad.advertiser.nickName,
      min: parseFloat(ad.adv.minSingleTransAmount),
      max: parseFloat(ad.adv.maxSingleTransAmount),
    }))
    .sort((a, b) => b.price - a.price);

  const bestSellPrice = sellers[0].price;  // cheapest to buy from
  const bestBuyPrice = buyers[0].price;    // highest to sell to

  const gap = bestBuyPrice - bestSellPrice;
  const gapPct = (gap / bestSellPrice) * 100;

  // Profit on $100
  const usdtAmount = 100;
  const kesCost = usdtAmount * bestSellPrice;
  const kesReceived = usdtAmount * bestBuyPrice;
  const profit100 = kesReceived - kesCost;

  console.log(`📊 ${coin}/KES | Buy from: ${fmt(bestSellPrice,1)} | Sell to: ${fmt(bestBuyPrice,1)} | Gap: ${fmt(gap,1)} KES (${fmt(gapPct,2)}%)`);

  return {
    coin,
    bestSellPrice,
    bestBuyPrice,
    bestSeller: sellers[0],
    bestBuyer: buyers[0],
    gap,
    gapPct,
    profit100,
    sellers: sellers.slice(0, 3),
    buyers: buyers.slice(0, 3)
  };
}

// ─── MAIN SCAN LOOP ───────────────────────────────────────
async function scan() {
  scanCount++;
  const time = new Date().toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi' });
  console.log(`\n🔍 Scan #${scanCount} at ${time} EAT`);

  for (const coin of COINS) {
    try {
      const result = await scanCoin(coin);
      if (!result) continue;

      // Check if gap is above threshold
      if (result.gap >= MIN_GAP) {
        opportunitiesFound++;

        // Avoid spamming — only alert once every 5 minutes per coin
        const now = Date.now();
        const lastAlert = lastAlertTime[coin] || 0;
        if (now - lastAlert < 5 * 60 * 1000) {
          console.log(`⏳ ${coin} alert suppressed (sent recently)`);
          continue;
        }

        lastAlertTime[coin] = now;

        const strengthEmoji = result.gap >= 5 ? '🔥' : result.gap >= 3 ? '⚡' : '💡';
        const strength = result.gap >= 5 ? 'STRONG' : result.gap >= 3 ? 'GOOD' : 'MILD';

        const message =
`${strengthEmoji} <b>ARB OPPORTUNITY · ${result.coin}/KES</b>

<b>Strength:</b> ${strength} (${fmt(result.gapPct, 2)}% gap)

💰 <b>Gap:</b> KES ${fmt(result.gap, 2)} per ${result.coin}

📥 <b>BUY from</b> (cheapest seller):
   KES ${fmt(result.bestSellPrice, 1)} — ${result.bestSeller.trader}
   Limit: KES ${fmt(result.bestSeller.min, 0)}–${fmt(result.bestSeller.max, 0)}

📤 <b>SELL to</b> (highest buyer):
   KES ${fmt(result.bestBuyPrice, 1)} — ${result.bestBuyer.trader}
   Limit: KES ${fmt(result.bestBuyer.min, 0)}–${fmt(result.bestBuyer.max, 0)}

💵 <b>Profit on $100:</b> +KES ${fmt(result.profit100, 0)}

<b>Steps:</b>
1️⃣ Go to Binance P2P → Buy ${result.coin}
2️⃣ Buy from <b>${result.bestSeller.trader}</b> at KES ${fmt(result.bestSellPrice, 1)}
3️⃣ Pay via M-Pesa, wait for confirmation
4️⃣ Go to Binance P2P → Sell ${result.coin}
5️⃣ Sell to <b>${result.bestBuyer.trader}</b> at KES ${fmt(result.bestBuyPrice, 1)}

⚠️ Act fast — gaps close in minutes
🕐 Spotted at ${time} EAT`;

        await sendTelegram(message);
      }

      // Small delay between coins
      await new Promise(r => setTimeout(r, 2000));

    } catch(e) {
      console.error(`❌ Error scanning ${coin}:`, e.message);
    }
  }

  console.log(`✅ Scan complete. Opportunities found so far: ${opportunitiesFound}`);
}

// ─── STARTUP MESSAGE ──────────────────────────────────────
async function startup() {
  console.log('🚀 P2P Arb Bot starting...');
  console.log(`📌 Monitoring: ${COINS.join(', ')} / KES`);
  console.log(`⚡ Alert threshold: KES ${MIN_GAP}`);
  console.log(`🔄 Scan interval: ${SCAN_INTERVAL / 1000}s`);

  await sendTelegram(
`🤖 <b>P2P Arb Bot is LIVE</b>

Monitoring <b>${COINS.join(', ')}/KES</b> on Binance P2P

⚡ Will alert when gap ≥ KES ${MIN_GAP}
🔄 Scanning every ${SCAN_INTERVAL / 1000} seconds
📍 Payment: M-Pesa

Ready to find opportunities! 🇰🇪`
  );
}

// ─── KEEP-ALIVE SERVER (required by Render) ───────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({
    status: 'running',
    scans: scanCount,
    opportunities: opportunitiesFound,
    coins: COINS,
    threshold: MIN_GAP,
    uptime: process.uptime()
  }));
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive server on port ${process.env.PORT || 3000}`);
});

// ─── START ────────────────────────────────────────────────
startup().then(() => {
  scan(); // immediate first scan
  setInterval(scan, SCAN_INTERVAL);
});
