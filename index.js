import express from "express";
import dotenv from "dotenv";
import Binance from "node-binance-api";

dotenv.config();

const app = express();
app.use(express.json());

/* =========================
   🔐 BINANCE CONNECTION
========================= */

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4, // ضروري لتجاوز قيود الشبكة على السيرفرات
  useServerTime: true
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
   📡 PRICE FETCH (REST API)
   تم استبدال الـ WebSocket لتجنب خطأ 451 على Render
========================= */

let lastPrice = 0;

async function fetchPrice() {
  try {
    const ticker = await binance.prices("BTCUSDT");
    lastPrice = parseFloat(ticker.BTCUSDT);
  } catch (error) {
    console.error("Price fetch error:", error.message);
  }
}

// تحديث السعر كل 5 ثوانٍ لضمان استقرار الاتصال
setInterval(fetchPrice, 5000);
fetchPrice(); // جلب السعر فور التشغيل

/* =========================
   🧠 STRATEGY ENGINE
========================= */

function getSignal(price) {
  const rsi = 30 + Math.random() * 40;
  let score = 0;
  if (rsi < 35) score += 2;
  if (rsi > 70) score -= 2;
  return score;
}

/* =========================
   💰 POSITION SIZE
========================= */

function positionSize(balance) {
  return balance * 0.01; 
}

/* =========================
   📥 REAL ORDER EXECUTION
========================= */

async function openTrade() {
  try {
    const balance = account.balance || 100;
    const quantity = (positionSize(balance) / lastPrice).toFixed(5); 

    const order = await binance.marketBuy("BTCUSDT", quantity);

    account.openPositions.push({
      id: Date.now(),
      entry: lastPrice,
      qty: quantity,
      orderId: order.orderId,
      status: "OPEN"
    });

    console.log("🟢 REAL BUY EXECUTED");
  } catch (e) {
    console.error("BUY ERROR:", e.body || e);
  }
}

/* =========================
   📉 CLOSE TRADE
========================= */

async function closeTrade(position) {
  try {
    await binance.marketSell("BTCUSDT", position.qty);
    account.closedPositions.push({
      ...position,
      exit: lastPrice,
      status: "CLOSED"
    });
    console.log("🔴 REAL SELL EXECUTED");
  } catch (e) {
    console.error("SELL ERROR:", e.body || e);
  }
}

/* =========================
   🚀 BOT ENGINE
========================= */

function startBot() {
  if (account.running) return;
  account.running = true;

  setInterval(async () => {
    if (!lastPrice) return;
    const signal = getSignal(lastPrice);

    if (signal > 1 && account.openPositions.length < 1) {
      await openTrade();
    }

    for (let pos of account.openPositions) {
      const profit = lastPrice - pos.entry;
      if (profit > 5 || profit < -3) {
        await closeTrade(pos);
        pos.status = "CLOSED";
      }
    }
    account.openPositions = account.openPositions.filter(p => p.status === "OPEN");
  }, 3000);
}

/* =========================
   🌐 API
========================= */

app.post("/start", (req, res) => {
  startBot();
  res.json({ status: "LIVE TRADING STARTED 🚀" });
});

app.get("/status", async (req, res) => {
  try {
    const balance = await binance.balance();
    res.json({
      lastPrice,
      balance,
      open: account.openPositions,
      closed: account.closedPositions
    });
  } catch (error) {
    res.status(500).json({ error: "فشل جلب البيانات من بينانس", details: error.message });
  }
});

/* =========================
   🚀 SERVER
========================= */

// استخدام المنفذ الديناميكي الخاص بـ Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LIVE BINANCE BOT ACTIVE ON PORT ${PORT}`);
});
