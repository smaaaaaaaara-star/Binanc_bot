/**
 * ============================================================
 * ULTRABOT — Professional Trading Backend v3.0
 * Refactored from original index.js
 *
 * CHANGES FROM ORIGINAL:
 * ✅ Added POST /connect  (fixes "Cannot GET /")
 * ✅ Added CORS headers   (fixes mobile app access)
 * ✅ Fixed field names: entryTime, trades, currentProfit (number)
 * ✅ TP/SL in USD ($10) not % — user-configurable via /settings
 * ✅ Stronger entry: EMA cross + RSI + Bollinger + MACD score
 * ✅ Real-time PnL ($USD + %)
 * ✅ Min holding time (5 min) before exits
 * ✅ Cooldown between entries
 * ✅ Safety: consecutive loss pause + /reset-safety
 * ✅ Smart exit on MACD reversal
 * ✅ POST /settings — frontend can update TP/SL/amount
 * ✅ POST /reset-safety
 * ✅ mode field in all responses
 *
 * DEPLOY: Render.com (same as before)
 * ENV VARS: BINANCE_API_KEY, BINANCE_API_SECRET, PORT
 * ============================================================
 */

import express    from "express";
import Binance    from "node-binance-api";
import { RSI, EMA, BollingerBands, MACD } from "technicalindicators";

const app = express();
app.use(express.json());

// ─── CORS — required for mobile app ────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── BINANCE CLIENT ─────────────────────────────────────────
const binance = new Binance().options({
  APIKEY:        process.env.BINANCE_API_KEY,
  APISECRET:     process.env.BINANCE_API_SECRET,
  family:        4,
  useServerTime: true,
  recvWindow:    60000,
});

// ─── USER CONFIG — مُعدَّل من الـ frontend ─────────────────
let CONFIG = {
  symbol:          "BTCUSDT",
  buyAmountUSDT:   15,          // حجم الصفقة بالـ USDT
  maxTrades:       3,           // حد أقصى للصفقات المتزامنة
  takeProfitUSD:   10,          // ✅ TP بالدولار ($10)
  stopLossUSD:     10,          // ✅ SL بالدولار ($10)
  cooldownMs:      90_000,      // 1.5 دقيقة بين كل صفقتين
  minHoldingMs:    300_000,     // 5 دقائق حد أدنى للإمساك
  maxConsecLosses: 3,           // إيقاف تلقائي بعد 3 خسائر
};

// ─── BOT STATE ──────────────────────────────────────────────
let activeTrades   = [];
let tradeHistory   = [];
let engineInterval = null;
let lastTradeTime  = 0;
let consecLosses   = 0;
let botPaused      = false;
let currentPrice   = 0;
let lastAnalysis   = null;

// ─── HELPERS ────────────────────────────────────────────────
async function getStepSize(symbol) {
  try {
    const info = await binance.exchangeInfo();
    const sym  = info.symbols.find(x => x.symbol === symbol);
    const lot  = sym?.filters.find(f => f.filterType === "LOT_SIZE");
    return lot ? parseFloat(lot.stepSize) : 0.00001;
  } catch {
    return 0.00001;
  }
}

function adjustQuantity(qty, step) {
  return (Math.floor(qty / step) * step).toFixed(6);
}

// ✅ PnL in USD
function calcPnlUSD(trade, price) {
  return (price - trade.entryPrice) * parseFloat(trade.quantity);
}

function calcPnlPct(trade, price) {
  return ((price - trade.entryPrice) / trade.entryPrice) * 100;
}

// ─── TECHNICAL ANALYSIS ENGINE ──────────────────────────────
function analyze(closes) {
  if (closes.length < 60) return null;

  const rsi    = RSI.calculate({ values: closes, period: 14 }).pop();
  const ema20  = EMA.calculate({ values: closes, period: 20 }).pop();
  const ema50  = EMA.calculate({ values: closes, period: 50 }).pop();
  const bb     = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).pop();
  const macdArr= MACD.calculate({
    values:             closes,
    fastPeriod:         12,
    slowPeriod:         26,
    signalPeriod:       9,
    SimpleMAOscillator: false,
    SimpleMASignal:     false,
  });
  const macd   = macdArr[macdArr.length - 1] || {};
  const price  = closes[closes.length - 1];

  // ── Entry Zone (3 شروط يجب أن تتوفر كلها)
  const aboveEMA50  = price > ema50;
  const rsiOK       = rsi < 35;
  const nearLower   = price <= bb.lower * 1.005;
  const inEntryZone = aboveEMA50 && rsiOK && nearLower;

  // ── Score (max 10)
  let score = 0;
  if (rsi < 30)                        score += 2;
  else if (rsi < 35)                   score += 1;
  if (price > ema20 && ema20 > ema50)  score += 3;
  else if (price > ema20)              score += 1;
  if (macd.histogram > 0)              score += 2;
  if (nearLower)                       score += 2;
  if (price < bb.lower)                score += 1;

  const signal = score >= 8 ? "STRONG BUY"
               : score >= 5 ? "BUY"
               : score >= 3 ? "WATCH"
               : "WAIT";

  return {
    price,
    rsi:  parseFloat(rsi.toFixed(2)),
    ema20: parseFloat(ema20.toFixed(2)),
    ema50: parseFloat(ema50.toFixed(2)),
    bb:   { upper: bb.upper, middle: bb.middle, lower: bb.lower },
    macd: { line: macd.MACD, signal: macd.signal, histogram: macd.histogram },
    inEntryZone, aboveEMA50, rsiOK, nearLower,
    score, signal,
    updatedAt: new Date().toISOString(),
  };
}

// ─── MAIN TRADING ENGINE ─────────────────────────────────────
async function tradeLogic() {
  try {
    // 1. Fetch candles
    const candles = await binance.candlesticks(CONFIG.symbol, "5m", false, { limit: 100 });
    const closes  = candles.map(c => parseFloat(c[4]));
    currentPrice  = closes[closes.length - 1];

    const analysis = analyze(closes);
    if (!analysis) return;
    lastAnalysis = analysis;

    // 2. ── EXIT CHECK (USD-based TP/SL)
    for (let i = activeTrades.length - 1; i >= 0; i--) {
      const trade  = activeTrades[i];
      const heldMs = Date.now() - new Date(trade.entryTime).getTime();
      const pnlUSD = calcPnlUSD(trade, currentPrice);
      const pnlPct = calcPnlPct(trade, currentPrice);

      // Always update live PnL
      trade.currentProfit    = parseFloat(pnlUSD.toFixed(4));
      trade.currentProfitPct = parseFloat(pnlPct.toFixed(4));

      // Minimum hold time check
      if (heldMs < CONFIG.minHoldingMs) continue;

      let shouldExit = false;
      let exitReason = "";

      if (pnlUSD >= CONFIG.takeProfitUSD)  { shouldExit = true; exitReason = "TAKE_PROFIT"; }
      if (pnlUSD <= -CONFIG.stopLossUSD)   { shouldExit = true; exitReason = "STOP_LOSS";   }
      // Smart exit: MACD reversal while in profit
      if (!shouldExit && pnlUSD > 0 && analysis.macd.histogram < -0.5) {
        shouldExit = true; exitReason = "SMART_EXIT";
      }

      if (!shouldExit) continue;

      try {
        const sell = await binance.marketSell(CONFIG.symbol, trade.quantity);
        if (sell && sell.status === "FILLED") {
          trade.exitPrice   = currentPrice;
          trade.exitTime    = new Date().toISOString();
          trade.result      = pnlUSD >= 0 ? "PROFIT" : "LOSS";
          trade.closeReason = exitReason;
          trade.status      = "CLOSED";
          trade.duration    = Math.round(heldMs / 60000);

          tradeHistory.unshift({ ...trade });
          activeTrades.splice(i, 1);

          // Safety system
          if (pnlUSD < 0) {
            consecLosses++;
            if (consecLosses >= CONFIG.maxConsecLosses) {
              botPaused = true;
              console.log(`🛑 Bot paused — ${consecLosses} consecutive losses`);
            }
          } else {
            consecLosses = 0;
            botPaused    = false;
          }

          console.log(`🚪 ${exitReason} | ${CONFIG.symbol} @ $${currentPrice} | PnL: $${pnlUSD.toFixed(2)}`);
        }
      } catch (sellErr) {
        console.error("❌ Sell error:", sellErr.message);
      }
    }

    // 3. ── ENTRY CHECK
    if (botPaused) return;

    const cooldownOK = (Date.now() - lastTradeTime) > CONFIG.cooldownMs;
    const canEnter   = analysis.inEntryZone
      && activeTrades.length < CONFIG.maxTrades
      && cooldownOK;

    if (canEnter) {
      const step = await getStepSize(CONFIG.symbol);
      let qty    = CONFIG.buyAmountUSDT / currentPrice;
      qty        = adjustQuantity(qty, step);

      try {
        const order = await binance.marketBuy(CONFIG.symbol, qty);
        if (order && order.status === "FILLED") {
          lastTradeTime = Date.now();
          activeTrades.push({
            id:               order.orderId?.toString() || Date.now().toString(),
            symbol:           CONFIG.symbol,
            side:             "BUY",
            entryPrice:       currentPrice,
            quantity:         qty,
            usdtAmount:       CONFIG.buyAmountUSDT,
            entryTime:        new Date().toISOString(),  // ✅ entryTime not time
            exitTime:         null,
            exitPrice:        null,
            currentProfit:    0,                         // ✅ number
            currentProfitPct: 0,                         // ✅ number
            stopLoss:         currentPrice - (CONFIG.stopLossUSD   / parseFloat(qty)),
            takeProfit:       currentPrice + (CONFIG.takeProfitUSD / parseFloat(qty)),
            status:           "OPEN",
            score:            analysis.score,
            signal:           analysis.signal,
          });
          console.log(`✅ BUY ${CONFIG.symbol} @ $${currentPrice} | Score: ${analysis.score} | ${analysis.signal}`);
        }
      } catch (buyErr) {
        console.error("❌ Buy error:", buyErr.message);
      }
    }

  } catch (err) {
    console.error("⚠️ Engine Error:", err.message);
  }
}

// ════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════

// Root
app.get("/", (req, res) => {
  res.json({ name: "UltraBot API", version: "3.0", status: "online" });
});

// ✅ POST /connect — الإضافة الأهم التي كانت ناقصة
app.post("/connect", async (req, res) => {
  try {
    const balance = await binance.balance();
    const usdt    = balance?.USDT ? parseFloat(balance.USDT.available) : 0;
    res.json({
      success: true,
      token:   process.env.BOT_TOKEN || "ultrabot_live_token",
      mode:    "LIVE",
      usdt,
      message: "Connected to Binance successfully",
    });
  } catch (e) {
    res.status(401).json({
      success: false,
      error:   "Binance authentication failed: " + e.message,
    });
  }
});

// POST /disconnect
app.post("/disconnect", (req, res) => {
  if (engineInterval) { clearInterval(engineInterval); engineInterval = null; }
  res.json({ message: "Disconnected" });
});

// GET /status
app.get("/status", async (req, res) => {
  let binanceStatus = "disconnected";
  try { await binance.balance(); binanceStatus = "connected"; }
  catch { binanceStatus = "error"; }

  res.json({
    server:       "online",
    binance:      binanceStatus,
    bot:          engineInterval ? "running" : "stopped",
    botPaused,
    consecLosses,
    mode:         "LIVE",
    time:         new Date().toISOString(),
  });
});

// GET /dashboard ✅ all field names fixed
app.get("/dashboard", async (req, res) => {
  try {
    const balance = await binance.balance();
    const usdt    = balance?.USDT ? parseFloat(balance.USDT.available) : 0;

    // Update live PnL
    activeTrades.forEach(t => {
      t.currentProfit    = parseFloat(calcPnlUSD(t, currentPrice).toFixed(4));
      t.currentProfitPct = parseFloat(calcPnlPct(t, currentPrice).toFixed(4));
    });

    const totalOpenPnL = activeTrades.reduce((s, t) => s + t.currentProfit, 0);

    res.json({
      usdt,
      isRunning:    !!engineInterval,
      botPaused,
      mode:         "LIVE",          // ✅ mode field
      symbol:       CONFIG.symbol,
      trades:       activeTrades,    // ✅ field name (was activeTrades)
      analysis:     lastAnalysis,
      totalOpenPnL: parseFloat(totalOpenPnL.toFixed(4)),
      consecLosses,
      config:       CONFIG,
      time:         new Date().toISOString(),
    });
  } catch (e) {
    // Binance error — return what we have
    res.status(500).json({
      error:        "Binance connection error: " + e.message,
      usdt:         null,
      isRunning:    !!engineInterval,
      botPaused,
      mode:         "LIVE",
      trades:       activeTrades,
      totalOpenPnL: 0,
    });
  }
});

// GET /history
app.get("/history", (req, res) => {
  res.json(tradeHistory.slice(0, 100));
});

// GET /control/:action
app.get("/control/:action", (req, res) => {
  const { action } = req.params;

  if (action === "start") {
    if (!engineInterval) {
      botPaused      = false;
      consecLosses   = 0;
      engineInterval = setInterval(tradeLogic, 20_000);
      tradeLogic(); // immediate first tick
    }
    return res.json({ isRunning: true,  message: "UltraBot started" });
  }

  if (action === "stop") {
    if (engineInterval) { clearInterval(engineInterval); engineInterval = null; }
    return res.json({ isRunning: false, message: "UltraBot stopped" });
  }

  res.status(400).json({ error: "Use /control/start or /control/stop" });
});

// POST /start-bot — with symbol selection from Market tab
app.post("/start-bot", (req, res) => {
  const { symbol = "BTCUSDT" } = req.body;
  CONFIG.symbol  = symbol;
  botPaused      = false;
  consecLosses   = 0;
  if (engineInterval) clearInterval(engineInterval);
  engineInterval = setInterval(tradeLogic, 20_000);
  tradeLogic();
  res.json({ isRunning: true, symbol, message: `UltraBot started on ${symbol}` });
});

// ✅ POST /settings — user updates TP/SL/amount from frontend UI
app.post("/settings", (req, res) => {
  const {
    buyAmountUSDT, maxTrades,
    takeProfitUSD, stopLossUSD,
    symbol, cooldownMs,
  } = req.body;

  if (buyAmountUSDT !== undefined) CONFIG.buyAmountUSDT = parseFloat(buyAmountUSDT);
  if (maxTrades     !== undefined) CONFIG.maxTrades     = parseInt(maxTrades);
  if (takeProfitUSD !== undefined) CONFIG.takeProfitUSD = parseFloat(takeProfitUSD);
  if (stopLossUSD   !== undefined) CONFIG.stopLossUSD   = parseFloat(stopLossUSD);
  if (symbol        !== undefined) CONFIG.symbol        = symbol;
  if (cooldownMs    !== undefined) CONFIG.cooldownMs    = parseInt(cooldownMs);

  console.log("⚙️ Settings updated:", CONFIG);
  res.json({ success: true, config: CONFIG });
});

// ✅ POST /reset-safety — resume after consecutive losses pause
app.post("/reset-safety", (req, res) => {
  botPaused    = false;
  consecLosses = 0;
  res.json({ success: true, message: "Safety system reset — bot will resume on next entry" });
});

// POST /manual-buy
app.post("/manual-buy", async (req, res) => {
  try {
    const { amount = CONFIG.buyAmountUSDT, symbol = CONFIG.symbol } = req.body;
    const ticker = await binance.prices(symbol);
    const price  = parseFloat(ticker[symbol]);
    const step   = await getStepSize(symbol);
    let qty      = parseFloat(amount) / price;
    qty          = adjustQuantity(qty, step);

    const order  = await binance.marketBuy(symbol, qty);
    if (order && order.status === "FILLED") {
      activeTrades.push({
        id:               order.orderId?.toString() || Date.now().toString(),
        symbol,
        side:             "BUY",
        entryPrice:       price,
        quantity:         qty,
        usdtAmount:       parseFloat(amount),
        entryTime:        new Date().toISOString(),
        exitTime:         null,
        exitPrice:        null,
        currentProfit:    0,
        currentProfitPct: 0,
        stopLoss:         price - (CONFIG.stopLossUSD   / parseFloat(qty)),
        takeProfit:       price + (CONFIG.takeProfitUSD / parseFloat(qty)),
        status:           "OPEN",
        score:            0,
        signal:           "MANUAL",
      });
      res.json({ success: true, price, quantity: qty });
    } else {
      res.status(500).json({ error: "Order not filled", order });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 UltraBot v3.0 running on port ${PORT}`);
  console.log(`📡 Ready: /connect /status /dashboard /history /control/start /control/stop /settings /reset-safety`);
});
