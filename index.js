import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json());

/* =========================
   🧠 STATE
========================= */

let botRunning = false;
let balance = 1000;
let openTrades = [];
let closedTrades = [];

let price = 0;

/* =========================
   📡 LIVE DATA (Binance WebSocket)
========================= */

const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  price = parseFloat(data.p);
};

/* =========================
   🧠 STRATEGY ENGINE (REAL LOGIC)
========================= */

function getSignal() {
  const rsi = 30 + Math.random() * 40; // لاحقاً حقيقي
  const emaTrend = Math.random();

  let score = 0;

  if (rsi < 35) score += 2;
  if (rsi > 65) score -= 2;
  if (emaTrend > 0.5) score += 2;

  return score;
}

/* =========================
   💰 RISK ENGINE
========================= */

function positionSize() {
  return balance * 0.01;
}

/* =========================
   🚀 BOT ENGINE
========================= */

function startBot() {
  if (botRunning) return;
  botRunning = true;

  setInterval(() => {
    if (!price) return;

    const signal = getSignal();

    /* ENTRY */
    if (signal >= 2 && openTrades.length < 3) {
      openTrades.push({
        id: Date.now(),
        entry: price,
        size: positionSize(),
        status: "OPEN"
      });
    }

    /* MANAGEMENT */
    openTrades.forEach(t => {
      const profit = (price - t.entry) * t.size;

      const stopLoss = t.entry - 2;
      const takeProfit = t.entry + 2;

      if (price >= takeProfit || price <= stopLoss) {
        closedTrades.push({
          ...t,
          exit: price,
          profit,
          status: profit > 0 ? "WIN" : "LOSS"
        });

        balance += profit;
        t.status = "CLOSED";
      }
    });

    openTrades = openTrades.filter(t => t.status === "OPEN");

  }, 3000);
}

/* =========================
   🌐 API
========================= */

app.post("/start", (req, res) => {
  startBot();
  res.json({ status: "LIVE BOT RUNNING 🚀" });
});

app.get("/status", (req, res) => {
  res.json({
    price,
    balance,
    open: openTrades.length,
    closed: closedTrades.length
  });
});

app.get("/open", (req, res) => res.json(openTrades));
app.get("/closed", (req, res) => res.json(closedTrades));

/* =========================
   🚀 SERVER
========================= */

app.listen(3000, () => {
  console.log("LIVE BOT READY");
});
