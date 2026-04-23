import express from "express";

const app = express();
app.use(express.json());

/* =========================
   🧠 PRO BOT STATE
========================= */

let botRunning = false;
let interval = null;

let balance = 1000; // محاكاة
let openTrades = [];
let closedTrades = [];

/* =========================
   📊 MARKET SIMULATION (لاحقاً Binance)
========================= */

function getMarketPrice() {
  return 100 + Math.sin(Date.now() / 10000) * 5 + Math.random();
}

/* =========================
   🧠 INDICATORS ENGINE (مهم)
========================= */

function getSignal(price) {
  const rsi = Math.random() * 100;
  const trend = Math.random(); // لاحقاً EMA

  let score = 0;

  if (rsi < 30) score += 3; // oversold
  if (rsi > 70) score -= 3; // overbought
  if (trend > 0.5) score += 2;

  return score;
}

/* =========================
   💰 POSITION SIZE (Risk Mgmt)
========================= */

function calculateSize() {
  return balance * 0.01; // 1% risk
}

/* =========================
   🚀 BOT CORE ENGINE
========================= */

function startBot() {
  if (botRunning) return;

  botRunning = true;

  interval = setInterval(() => {
    const price = getMarketPrice();
    const signal = getSignal(price);

    console.log("Price:", price, "Signal:", signal);

    /* =========================
       📥 ENTRY LOGIC (PRO)
    ========================= */

    if (signal >= 3 && openTrades.length < 5) {
      const size = calculateSize();

      openTrades.push({
        id: Date.now(),
        entry: price,
        size,
        direction: "BUY",
        status: "OPEN"
      });

      console.log("🟢 ENTER TRADE");
    }

    /* =========================
       📉 TRADE MANAGEMENT
    ========================= */

    openTrades.forEach(trade => {
      const profit = (price - trade.entry) * trade.size;

      const tp = trade.entry + 2;
      const sl = trade.entry - 2;

      if (price >= tp || price <= sl) {
        closedTrades.push({
          ...trade,
          exit: price,
          profit,
          status: profit > 0 ? "PROFIT" : "LOSS",
          closedAt: new Date()
        });

        balance += profit;
        trade.status = "CLOSED";

        console.log("🔴 CLOSE TRADE:", profit);
      }
    });

    openTrades = openTrades.filter(t => t.status === "OPEN");

  }, 3000);
}

/* =========================
   🛑 STOP BOT
========================= */

function stopBot() {
  botRunning = false;
  clearInterval(interval);
}

/* =========================
   🌐 API
========================= */

app.post("/start-bot", (req, res) => {
  startBot();
  res.json({ status: "PRO BOT STARTED 🚀" });
});

app.post("/stop-bot", (req, res) => {
  stopBot();
  res.json({ status: "STOPPED 🛑" });
});

app.get("/status", (req, res) => {
  res.json({
    running: botRunning,
    balance,
    openTrades: openTrades.length,
    closedTrades: closedTrades.length
  });
});

app.get("/open-trades", (req, res) => {
  res.json(openTrades);
});

app.get("/closed-trades", (req, res) => {
  res.json(closedTrades);
});

/* =========================
   🚀 SERVER START
========================= */

app.listen(3000, () => {
  console.log("🚀 PRO BOT RUNNING");
});
