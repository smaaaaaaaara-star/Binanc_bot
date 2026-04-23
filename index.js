import express from "express";
import Binance from "node-binance-api";
import { RSI, EMA, BollingerBands } from "technicalindicators";

const app = express();
app.use(express.json());

// --- 1. الاتصال ببينانس ---
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
  useServerTime: true,
  recvWindow: 60000
});

// --- 2. الإعدادات ---
const CONFIG = {
  symbol: "BTCUSDT",
  buyAmountUSDT: 15,
  maxTrades: 3,
  stopLossLimit: -2.0,
  takeProfitLimit: 4.0
};

let activeTrades = [];
let tradeHistory = [];
let engineInterval = null;

// منع التكرار
let lastTradeTime = 0;
const TRADE_COOLDOWN = 60000;

// precision
async function getStepSize(symbol) {
  try {
    const info = await binance.exchangeInfo();
    const s = info.symbols.find(x => x.symbol === symbol);
    const lot = s.filters.find(f => f.filterType === "LOT_SIZE");
    return parseFloat(lot.stepSize);
  } catch {
    return 0.00001;
  }
}

function adjustQuantity(qty, step) {
  return (Math.floor(qty / step) * step).toFixed(5);
}

// --- 3. منطق التداول ---
async function tradeLogic() {
  try {
    const candles = await binance.candlesticks(CONFIG.symbol, "5m");
    const closes = candles.map(c => parseFloat(c[4]));
    const currentPrice = closes[closes.length - 1];

    if (closes.length < 50) return;

    const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
    const ema50 = EMA.calculate({ values: closes, period: 50 }).pop();
    const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).pop();

    const isEntryZone = currentPrice > ema50 && rsi < 35 && currentPrice <= bb.lower;

    if (
      isEntryZone &&
      activeTrades.length < CONFIG.maxTrades &&
      Date.now() - lastTradeTime > TRADE_COOLDOWN
    ) {
      const step = await getStepSize(CONFIG.symbol);
      let qty = CONFIG.buyAmountUSDT / currentPrice;
      qty = adjustQuantity(qty, step);

      const order = await binance.marketBuy(CONFIG.symbol, qty);

      if (order && order.status === "FILLED") {
        lastTradeTime = Date.now();

        activeTrades.push({
          id: order.orderId || Date.now(),
          entryPrice: currentPrice,
          quantity: qty,
          time: new Date().toISOString(),
          status: "ACTIVE"
        });

        console.log("✅ شراء");
      }
    }

    for (let i = activeTrades.length - 1; i >= 0; i--) {
      let trade = activeTrades[i];
      const profit = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

      trade.currentProfit = profit.toFixed(2) + "%";

      if (profit >= CONFIG.takeProfitLimit || profit <= CONFIG.stopLossLimit) {
        const sell = await binance.marketSell(CONFIG.symbol, trade.quantity);

        if (sell && sell.status === "FILLED") {
          trade.exitPrice = currentPrice;
          trade.result = profit >= 0 ? "PROFIT" : "LOSS";
          trade.exitTime = new Date().toISOString();

          tradeHistory.unshift(trade);
          activeTrades.splice(i, 1);

          console.log("🛑 إغلاق صفقة");
        }
      }
    }

  } catch (err) {
    console.error("Engine Error:", err.message);
  }
}

// --- 4. API ---

// تشغيل/إيقاف
app.get("/control/:action", (req, res) => {
  const { action } = req.params;

  if (action === "start") {
    if (!engineInterval) {
      engineInterval = setInterval(tradeLogic, 20000);
    }
    return res.json({ message: "Bot started" });
  } else {
    clearInterval(engineInterval);
    engineInterval = null;
    return res.json({ message: "Bot stopped" });
  }
});

// Dashboard
app.get("/dashboard", async (req, res) => {
  try {
    const balance = await binance.balance();

    res.json({
      usdt: balance.USDT ? balance.USDT.available : 0,
      activeTrades,
      isRunning: !!engineInterval
    });
  } catch {
    res.status(500).send("Error");
  }
});

// History
app.get("/history", (req, res) => {
  res.json(tradeHistory);
});

// ✅ Status (الإضافة الوحيدة)
app.get("/status", async (req, res) => {
  try {
    let binanceStatus = "disconnected";

    try {
      await binance.balance();
      binanceStatus = "connected";
    } catch {
      binanceStatus = "error";
    }

    res.json({
      server: "online",
      binance: binanceStatus,
      bot: engineInterval ? "running" : "stopped",
      time: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({
      server: "offline",
      error: err.message
    });
  }
});

// شراء يدوي
app.post("/manual-buy", async (req, res) => {
  try {
    const { amount } = req.body;

    const ticker = await binance.prices(CONFIG.symbol);
    const price = parseFloat(ticker[CONFIG.symbol]);

    const step = await getStepSize(CONFIG.symbol);
    let qty = amount / price;
    qty = adjustQuantity(qty, step);

    const order = await binance.marketBuy(CONFIG.symbol, qty);

    if (order && order.status === "FILLED") {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: "Order failed" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 السيرفر يعمل على ${PORT}`));
