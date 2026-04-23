import express from "express";
import dotenv from "dotenv";
import Binance from "node-binance-api";

dotenv.config();

const app = express();
app.use(express.json());

/* =========================
   🔐 BINANCE CONNECTION
   (Direct Keys Version)
========================= */

const binance = new Binance().options({
  // ضع مفاتيحك الحقيقية هنا بين علامات الاقتباس
  APIKEY: 'rBOu1KZbNhYQPx7Bdl35JV6fYcHX0WKS7pcbRxngwaAvqf6e9lOuvsvf1EfzaDMT', 
  APISECRET: 'IaKvN1DzNDt4SH5vzqbfB5fZ6eiZmC7dbiD77cn7WTsBGOfLyXw2zkX4RxS9yKdf',
  family: 4,               
  useServerTime: true,     
  recvWindow: 60000        
});

/* =========================
   💰 ACCOUNT STATE
========================= */

let account = {
  balance: 0,
  openPositions: [],
  closedPositions: [],
  running: false
};

/* =========================
   📡 PRICE FETCH
========================= */

let lastPrice = 0;

async function fetchPrice() {
  try {
    const ticker = await binance.prices("BTCUSDT");
    lastPrice = parseFloat(ticker.BTCUSDT);
    // سيظهر السعر في الـ Logs إذا كانت المفاتيح صحيحة
    console.log(`Current BTC Price: ${lastPrice}`);
  } catch (error) {
    console.error("Price fetch error:", error.message);
  }
}

// تحديث السعر كل 5 ثوانٍ
setInterval(fetchPrice, 5000);
fetchPrice();

/* =========================
   🧠 STRATEGY (Example)
========================= */

function getSignal() {
  const rsi = 30 + Math.random() * 40; 
  if (rsi < 35) return 2; // Buy
  if (rsi > 70) return -2; // Sell
  return 0;
}

/* =========================
   📥 EXECUTION
========================= */

async function openTrade() {
  try {
    // يحاول الشراء بـ 15 دولار كمثال (تأكد من وجود رصيد USDT)
    const quantity = (15 / lastPrice).toFixed(5); 
    const order = await binance.marketBuy("BTCUSDT", quantity);

    account.openPositions.push({
      id: Date.now(),
      entry: lastPrice,
      qty: quantity,
      orderId: order.orderId,
      status: "OPEN"
    });
    console.log("🟢 SUCCESS: REAL BUY ORDER PLACED");
  } catch (e) {
    console.error("BUY ERROR:", e.body || e.message);
  }
}

async function closeTrade(position) {
  try {
    await binance.marketSell("BTCUSDT", position.qty);
    account.closedPositions.push({ ...position, exit: lastPrice, status: "CLOSED" });
    console.log("🔴 SUCCESS: REAL SELL ORDER PLACED");
  } catch (e) {
    console.error("SELL ERROR:", e.body || e.message);
  }
}

/* =========================
   🚀 BOT ENGINE
========================= */

function startBot() {
  if (account.running) return;
  account.running = true;
  console.log("🤖 Bot Engine Started...");

  setInterval(async () => {
    if (!lastPrice) return;
    const signal = getSignal();

    if (signal > 1 && account.openPositions.length < 1) {
      await openTrade();
    }

    for (let pos of account.openPositions) {
      const profit = lastPrice - pos.entry;
      if (profit > 10 || profit < -5) { 
        await closeTrade(pos);
        pos.status = "CLOSED";
      }
    }
    account.openPositions = account.openPositions.filter(p => p.status === "OPEN");
  }, 5000);
}

/* =========================
   🌐 API ENDPOINTS
========================= */

// لتشغيل البوت
app.get("/start", (req, res) => {
  startBot();
  res.send("<h1>Bot is now running! 🚀</h1>");
});

// لفحص الحالة والرصيد
app.get("/status", async (req, res) => {
  try {
    const balance = await binance.balance();
    res.json({
      bot_running: account.running,
      current_btc_price: lastPrice,
      wallet_balance: balance,
      active_trades: account.openPositions
    });
  } catch (error) {
    res.status(500).json({ error: "Binance Connection Failed", details: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server active on port ${PORT}`);
});
