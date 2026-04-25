/**
 * ============================================================
 * ULTRABOT BACKEND v4.0 — Professional Grade
 * Bot runs independently in background on server startup
 * Frontend is display-only — reflects server state
 * ============================================================
 * ENV VARS (Render.com):
 *   BINANCE_API_KEY=...
 *   BINANCE_API_SECRET=...
 *   PORT=10000
 *   AUTO_START=true          ← بوت يشتغل تلقائياً عند تشغيل السيرفر
 *   DEFAULT_SYMBOL=BTCUSDT
 *   BUY_AMOUNT_USDT=15
 *   TAKE_PROFIT_USD=10
 *   STOP_LOSS_USD=10
 * ============================================================
 */

import express from "express";
import Binance from "node-binance-api";
import { RSI, EMA, BollingerBands, MACD } from "technicalindicators";

const app = express();
app.use(express.json());

// ─── CORS ───────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── BINANCE ────────────────────────────────────────────────
const binance = new Binance().options({
  APIKEY:        process.env.BINANCE_API_KEY,
  APISECRET:     process.env.BINANCE_API_SECRET,
  family:        4,
  useServerTime: true,
  recvWindow:    60000,
});

// ─── CONFIG (overridable via /settings) ────────────────────
let CONFIG = {
  symbol:          process.env.DEFAULT_SYMBOL       || "BTCUSDT",
  buyAmountUSDT:   parseFloat(process.env.BUY_AMOUNT_USDT || "15"),
  maxTrades:       parseInt(process.env.MAX_TRADES   || "3"),
  takeProfitUSD:   parseFloat(process.env.TAKE_PROFIT_USD || "10"),
  stopLossUSD:     parseFloat(process.env.STOP_LOSS_USD   || "10"),
  cooldownMs:      90_000,   // 1.5 min between entries
  minHoldingMs:    300_000,  // 5 min minimum hold before exit check
  maxConsecLosses: 3,
  interval:        "5m",     // candle interval
  tickMs:          20_000,   // engine tick every 20s
};

// ─── BOT STATE ──────────────────────────────────────────────
const BOT = {
  isRunning:     false,
  isPaused:      false,
  engineTimer:   null,
  lastTradeTime: 0,
  consecLosses:  0,
  currentPrice:  0,
  analysis:      null,       // latest indicator snapshot
  activeTrades:  [],
  closedTrades:  [],
  events:        [],         // event log (trade opened/closed/etc)
  startedAt:     null,
  stats: {
    totalTrades:  0,
    wins:         0,
    losses:       0,
    totalPnlUSD:  0,
  },
};

// ─── EVENT LOG ──────────────────────────────────────────────
function logEvent(type, message, data = {}) {
  const event = { type, message, data, time: new Date().toISOString() };
  BOT.events.unshift(event);
  if (BOT.events.length > 100) BOT.events.pop();
  console.log(`[${type}] ${message}`);
}

// ─── HELPERS ────────────────────────────────────────────────
async function getStepSize(symbol) {
  try {
    const info = await binance.exchangeInfo();
    const sym  = info.symbols.find(x => x.symbol === symbol);
    const lot  = sym?.filters.find(f => f.filterType === "LOT_SIZE");
    return lot ? parseFloat(lot.stepSize) : 0.00001;
  } catch { return 0.00001; }
}

function floorQty(qty, step) {
  return parseFloat((Math.floor(qty / step) * step).toFixed(6));
}

function pnlUSD(trade, price) {
  return (price - trade.entryPrice) * parseFloat(trade.quantity);
}

function pnlPct(trade, price) {
  return ((price - trade.entryPrice) / trade.entryPrice) * 100;
}

// ─── TECHNICAL ANALYSIS ─────────────────────────────────────
function runAnalysis(closes) {
  if (closes.length < 60) return null;

  const price  = closes.at(-1);
  const rsiArr = RSI.calculate({ values: closes, period: 14 });
  const rsi    = rsiArr.at(-1);
  const ema20  = EMA.calculate({ values: closes, period: 20 }).at(-1);
  const ema50  = EMA.calculate({ values: closes, period: 50 }).at(-1);
  const bbArr  = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bb     = bbArr.at(-1);
  const macdArr= MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const macd   = macdArr.at(-1) || {};

  // ── Entry conditions
  const cond = {
    aboveEMA50: price > ema50,                  // uptrend
    rsiOversold: rsi < 35,                      // oversold
    nearLowerBand: price <= bb.lower * 1.005,   // near support
    macdBullish: macd.histogram > 0,            // momentum
  };

  // Need ALL 3 primary conditions
  const inEntryZone = cond.aboveEMA50 && cond.rsiOversold && cond.nearLowerBand;

  // Score 0-10
  let score = 0;
  if (rsi < 30)                          score += 3;
  else if (rsi < 35)                     score += 2;
  if (price > ema20 && ema20 > ema50)    score += 3;
  else if (price > ema20)                score += 1;
  if (macd.histogram > 0)                score += 2;
  if (cond.nearLowerBand)                score += 2;

  const signal = score >= 8 ? "STRONG BUY"
               : score >= 6 ? "BUY"
               : score >= 4 ? "WATCH"
               : "WAIT";

  return {
    price, rsi: +rsi.toFixed(2),
    ema20: +ema20.toFixed(2), ema50: +ema50.toFixed(2),
    bb: { upper: +bb.upper.toFixed(2), middle: +bb.middle.toFixed(2), lower: +bb.lower.toFixed(2) },
    macd: { line: macd.MACD, signal: macd.signal, histogram: macd.histogram },
    cond, inEntryZone, score, signal,
    updatedAt: new Date().toISOString(),
  };
}

// ─── EXIT MANAGER ───────────────────────────────────────────
async function checkExits(price, macdHistogram) {
  for (let i = BOT.activeTrades.length - 1; i >= 0; i--) {
    const trade  = BOT.activeTrades[i];
    const heldMs = Date.now() - new Date(trade.entryTime).getTime();

    // Update live PnL always
    trade.currentProfitUSD = +pnlUSD(trade, price).toFixed(4);
    trade.currentProfitPct = +pnlPct(trade, price).toFixed(4);

    // Don't exit before minimum holding time
    if (heldMs < CONFIG.minHoldingMs) continue;

    const pusd = trade.currentProfitUSD;
    let shouldExit = false, reason = "";

    if (pusd >= CONFIG.takeProfitUSD)  { shouldExit = true; reason = "TAKE_PROFIT"; }
    if (pusd <= -CONFIG.stopLossUSD)   { shouldExit = true; reason = "STOP_LOSS";   }
    if (!shouldExit && pusd > 0 && macdHistogram < -0.5) {
      shouldExit = true; reason = "SMART_EXIT";
    }

    if (!shouldExit) continue;

    // ── Execute sell
    try {
      const sell = await binance.marketSell(trade.symbol, trade.quantity);
      if (sell?.status === "FILLED") {
        const closed = {
          ...trade,
          exitPrice:    price,
          exitTime:     new Date().toISOString(),
          finalPnlUSD:  +pusd.toFixed(4),
          finalPnlPct:  +trade.currentProfitPct.toFixed(4),
          result:       pusd >= 0 ? "PROFIT" : "LOSS",
          closeReason:  reason,
          durationMin:  Math.round(heldMs / 60000),
          status:       "CLOSED",
        };

        BOT.closedTrades.unshift(closed);
        BOT.activeTrades.splice(i, 1);
        BOT.stats.totalTrades++;
        BOT.stats.totalPnlUSD = +(BOT.stats.totalPnlUSD + pusd).toFixed(4);

        if (pusd >= 0) {
          BOT.stats.wins++;
          BOT.consecLosses = 0;
          BOT.isPaused = false;
        } else {
          BOT.stats.losses++;
          BOT.consecLosses++;
          if (BOT.consecLosses >= CONFIG.maxConsecLosses) {
            BOT.isPaused = true;
            logEvent("BOT_PAUSED", `Paused after ${BOT.consecLosses} consecutive losses`);
          }
        }

        logEvent(
          closed.result,
          `${reason} ${trade.symbol} @ $${price} | PnL: $${pusd.toFixed(2)} (${closed.finalPnlPct.toFixed(2)}%)`,
          closed
        );
      }
    } catch (err) {
      logEvent("SELL_ERROR", err.message);
    }
  }
}

// ─── ENTRY MANAGER ──────────────────────────────────────────
async function tryEntry(analysis) {
  if (BOT.isPaused)                                          return;
  if (!analysis.inEntryZone)                                 return;
  if (BOT.activeTrades.length >= CONFIG.maxTrades)           return;
  if (Date.now() - BOT.lastTradeTime < CONFIG.cooldownMs)    return;

  // Prevent same-direction duplicate
  const sameSide = BOT.activeTrades.filter(t => t.side === "BUY").length;
  if (sameSide >= 2)                                         return;

  const price = analysis.price;
  const step  = await getStepSize(CONFIG.symbol);
  const qty   = floorQty(CONFIG.buyAmountUSDT / price, step);

  if (qty <= 0) return;

  try {
    const order = await binance.marketBuy(CONFIG.symbol, qty);
    if (order?.status === "FILLED") {
      BOT.lastTradeTime = Date.now();
      const trade = {
        id:               order.orderId?.toString() || `BOT_${Date.now()}`,
        symbol:           CONFIG.symbol,
        side:             "BUY",
        entryPrice:       price,
        quantity:         qty,
        usdtAmount:       CONFIG.buyAmountUSDT,
        entryTime:        new Date().toISOString(),
        exitTime:         null,
        exitPrice:        null,
        currentProfitUSD: 0,
        currentProfitPct: 0,
        stopLossPrice:    +(price - CONFIG.stopLossUSD / qty).toFixed(2),
        takeProfitPrice:  +(price + CONFIG.takeProfitUSD / qty).toFixed(2),
        status:           "OPEN",
        score:            analysis.score,
        signal:           analysis.signal,
        entryReason: {
          rsi:  analysis.rsi,
          ema50: analysis.ema50,
          bbLower: analysis.bb.lower,
        },
      };
      BOT.activeTrades.push(trade);
      logEvent("TRADE_OPENED", `BUY ${CONFIG.symbol} @ $${price} | Score:${analysis.score} | Qty:${qty}`, trade);
    }
  } catch (err) {
    logEvent("BUY_ERROR", err.message);
  }
}

// ─── MAIN ENGINE TICK ────────────────────────────────────────
async function engineTick() {
  try {
    const candles = await binance.candlesticks(CONFIG.symbol, CONFIG.interval, false, { limit: 100 });
    const closes  = candles.map(c => parseFloat(c[4]));
    BOT.currentPrice = closes.at(-1);

    const analysis = runAnalysis(closes);
    if (!analysis) return;
    BOT.analysis = analysis;

    // 1. Check exits
    await checkExits(BOT.currentPrice, analysis.macd.histogram);

    // 2. Try entry
    await tryEntry(analysis);

    // 3. Update live PnL on remaining open trades
    BOT.activeTrades.forEach(t => {
      t.currentProfitUSD = +pnlUSD(t, BOT.currentPrice).toFixed(4);
      t.currentProfitPct = +pnlPct(t, BOT.currentPrice).toFixed(4);
    });

  } catch (err) {
    logEvent("ENGINE_ERROR", err.message);
  }
}

// ─── BOT LIFECYCLE ──────────────────────────────────────────
function startBot(symbol) {
  if (BOT.isRunning) return;
  if (symbol) CONFIG.symbol = symbol;
  BOT.isRunning  = true;
  BOT.isPaused   = false;
  BOT.startedAt  = new Date().toISOString();
  BOT.engineTimer = setInterval(engineTick, CONFIG.tickMs);
  engineTick(); // immediate first tick
  logEvent("BOT_STARTED", `UltraBot started on ${CONFIG.symbol}`);
}

function stopBot() {
  if (BOT.engineTimer) { clearInterval(BOT.engineTimer); BOT.engineTimer = null; }
  BOT.isRunning = false;
  logEvent("BOT_STOPPED", "UltraBot stopped by user");
}

// ─── AUTO START on server boot ───────────────────────────────
if (process.env.AUTO_START === "true") {
  setTimeout(() => {
    startBot();
    logEvent("AUTO_START", `Auto-started on ${CONFIG.symbol}`);
  }, 3000); // 3s delay for server to initialize
}

// ════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.json({
  name: "UltraBot", version: "4.0", status: "online",
  bot: BOT.isRunning ? "running" : "stopped",
}));

// ── POST /connect
app.post("/connect", async (req, res) => {
  try {
    const balance = await binance.balance();
    const usdt    = balance?.USDT ? +parseFloat(balance.USDT.available).toFixed(4) : 0;
    res.json({
      success: true,
      token:   "ultrabot_token",
      mode:    "LIVE",
      usdt,
      botRunning: BOT.isRunning,
      message: "Connected to Binance",
    });
  } catch (e) {
    res.status(401).json({ success: false, error: "Binance auth failed: " + e.message });
  }
});

// ── POST /disconnect
app.post("/disconnect", (req, res) => {
  res.json({ message: "Disconnected" });
});

// ── GET /status
app.get("/status", async (req, res) => {
  let binanceStatus = "disconnected";
  try { await binance.ping(); binanceStatus = "connected"; }
  catch { binanceStatus = "error"; }

  res.json({
    server:       "online",
    binance:      binanceStatus,
    bot:          BOT.isRunning ? "running" : "stopped",
    botPaused:    BOT.isPaused,
    consecLosses: BOT.consecLosses,
    mode:         "LIVE",
    time:         new Date().toISOString(),
  });
});

// ── GET /dashboard  ← main data endpoint
app.get("/dashboard", async (req, res) => {
  let usdt = null;
  let binanceOk = true;

  try {
    const bal = await binance.balance();
    usdt = bal?.USDT ? +parseFloat(bal.USDT.available).toFixed(4) : 0;
  } catch { binanceOk = false; }

  // Refresh live PnL
  BOT.activeTrades.forEach(t => {
    t.currentProfitUSD = +pnlUSD(t, BOT.currentPrice).toFixed(4);
    t.currentProfitPct = +pnlPct(t, BOT.currentPrice).toFixed(4);
  });

  const totalOpenPnL = +BOT.activeTrades
    .reduce((s, t) => s + t.currentProfitUSD, 0).toFixed(4);

  res.json({
    // Balance
    usdt,
    binanceOk,
    // Bot state
    isRunning:    BOT.isRunning,
    botPaused:    BOT.isPaused,
    consecLosses: BOT.consecLosses,
    startedAt:    BOT.startedAt,
    mode:         "LIVE",
    symbol:       CONFIG.symbol,
    // Trades
    trades:       BOT.activeTrades,          // open positions
    totalOpenPnL,
    // Stats
    stats:        BOT.stats,
    winRate:      BOT.stats.totalTrades > 0
      ? +((BOT.stats.wins / BOT.stats.totalTrades) * 100).toFixed(1)
      : 0,
    // Analysis
    analysis:     BOT.analysis,
    currentPrice: BOT.currentPrice,
    // Config
    config:       CONFIG,
    // Recent events
    recentEvents: BOT.events.slice(0, 10),
    time:         new Date().toISOString(),
  });
});

// ── GET /history
app.get("/history", (req, res) => {
  res.json(BOT.closedTrades.slice(0, 100));
});

// ── GET /control/start  &  /control/stop
app.get("/control/:action", (req, res) => {
  const { action } = req.params;
  if (action === "start") {
    startBot();
    return res.json({ isRunning: true, message: "UltraBot started" });
  }
  if (action === "stop") {
    stopBot();
    return res.json({ isRunning: false, message: "UltraBot stopped" });
  }
  res.status(400).json({ error: "Use /control/start or /control/stop" });
});

// ── POST /start-bot (with symbol)
app.post("/start-bot", (req, res) => {
  const { symbol = "BTCUSDT" } = req.body;
  stopBot();
  startBot(symbol);
  res.json({ isRunning: true, symbol, message: `UltraBot started on ${symbol}` });
});

// ── POST /settings
app.post("/settings", (req, res) => {
  const { buyAmountUSDT, maxTrades, takeProfitUSD, stopLossUSD, symbol, cooldownMs } = req.body;
  if (buyAmountUSDT !== undefined) CONFIG.buyAmountUSDT = +buyAmountUSDT;
  if (maxTrades     !== undefined) CONFIG.maxTrades     = +maxTrades;
  if (takeProfitUSD !== undefined) CONFIG.takeProfitUSD = +takeProfitUSD;
  if (stopLossUSD   !== undefined) CONFIG.stopLossUSD   = +stopLossUSD;
  if (symbol        !== undefined) CONFIG.symbol        = symbol;
  if (cooldownMs    !== undefined) CONFIG.cooldownMs    = +cooldownMs;
  logEvent("SETTINGS_UPDATED", "Config updated", CONFIG);
  res.json({ success: true, config: CONFIG });
});

// ── POST /reset-safety
app.post("/reset-safety", (req, res) => {
  BOT.isPaused     = false;
  BOT.consecLosses = 0;
  logEvent("SAFETY_RESET", "Safety system reset — bot will resume");
  res.json({ success: true, message: "Safety reset" });
});

// ── GET /events  ← live event log
app.get("/events", (req, res) => {
  res.json(BOT.events.slice(0, 50));
});

// ── POST /manual-buy
app.post("/manual-buy", async (req, res) => {
  const { amount = CONFIG.buyAmountUSDT, symbol = CONFIG.symbol } = req.body;
  try {
    const ticker = await binance.prices(symbol);
    const price  = parseFloat(ticker[symbol]);
    const step   = await getStepSize(symbol);
    const qty    = floorQty(+amount / price, step);
    const order  = await binance.marketBuy(symbol, qty);

    if (order?.status === "FILLED") {
      const trade = {
        id:               order.orderId?.toString() || `MANUAL_${Date.now()}`,
        symbol, side: "BUY",
        entryPrice:       price, quantity: qty, usdtAmount: +amount,
        entryTime:        new Date().toISOString(),
        exitTime:         null, exitPrice: null,
        currentProfitUSD: 0, currentProfitPct: 0,
        stopLossPrice:    +(price - CONFIG.stopLossUSD   / qty).toFixed(2),
        takeProfitPrice:  +(price + CONFIG.takeProfitUSD / qty).toFixed(2),
        status:           "OPEN", score: 0, signal: "MANUAL",
      };
      BOT.activeTrades.push(trade);
      logEvent("MANUAL_BUY", `Manual BUY ${symbol} @ $${price}`, trade);
      res.json({ success: true, trade });
    } else {
      res.status(500).json({ error: "Order not filled", order });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START SERVER ────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 UltraBot v4.0 on port ${PORT}`);
  console.log(`⚙️  Symbol: ${CONFIG.symbol} | TP: $${CONFIG.takeProfitUSD} | SL: $${CONFIG.stopLossUSD}`);
  console.log(`📡 AUTO_START: ${process.env.AUTO_START || "false"}`);
});
