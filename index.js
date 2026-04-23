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
  APISECRET: process.env.BINANCE_API_SECRET
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
   📡 LIVE PRICE STREAM
========================= */

let lastPrice = 0;

binance.websockets.trades(["BTCUSDT"], (trades) => {
  lastPrice = parseFloat(trades.price);
});

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
  return balance * 0.01; // 1%
}

/* =========================
   📥 REAL ORDER EXECUTION
========================= */

async function openTrade() {
  const balance = account.balance || 100;

  const quantity = positionSize(balance) / lastPrice;

  const order = await binance.marketBuy("BTCUSDT", quantity);

  account.openPositions.push({
    id: Date.now(),
    entry: lastPrice,
    qty: quantity,
    orderId: order.orderId,
    status: "OPEN"
  });

  console.log("🟢 REAL BUY EXECUTED");
}

/* =========================
   📉 CLOSE TRADE
========================= */

async function closeTrade(position) {
  await binance.marketSell("BTCUSDT", position.qty);

  account.closedPositions.push({
    ...position,
    exit: lastPrice,
    status: "CLOSED"
  });

  console.log("🔴 REAL SELL EXECUTED");
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

    /* ENTRY */
    if (signal > 1 && account.openPositions.length < 1) {
      await openTrade();
    }

    /* EXIT */
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
  const balance = await binance.balance();

  res.json({
    lastPrice,
    balance,
    open: account.openPositions,
    closed: account.closedPositions
  });
});

/* =========================
   🚀 SERVER
========================= */

app.listen(3000, () => {
  console.log("LIVE BINANCE BOT ACTIVE");
});
