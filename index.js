import express from "express";
import dotenv from "dotenv";
import Binance from "node-binance-api";

// تفعيل قراءة ملفات البيئة (احتياطاً)
dotenv.config();

const app = express();
app.use(express.json());

/* =========================
   🔐 BINANCE CONNECTION (DIRECT KEYS)
   إعدادات كاملة لتجاوز كافة أخطاء الاتصال
========================= */

const binance = new Binance().options({
  // ⚠️ ضع مفاتيحك الحقيقية هنا بدقة
  APIKEY: 'rBOu1KZbNhYQPx7Bdl35JV6fYcHX0WKS7pcbRxngwaAvqf6e9lOuvsvf1EfzaDMT', 
  APISECRET: 'IaKvN1DzNDt4SH5vzqbfB5fZ6eiZmC7dbiD77cn7WTsBGOfLyXw2zkX4RxS9yKdf',
  
  family: 4,               // ضروري لتجاوز قيود IPv6 في Render
  useServerTime: true,     // حل جذري لمشكلة Binance Connection Failed (مزامنة الوقت)
  recvWindow: 60000,       // نافذة انتظار طويلة لتفادي رفض الطلبات بسبب التأخير
  log: () => {}            // الحفاظ على نظافة السجلات
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
========================= */

let lastPrice = 0;

async function fetchPrice() {
  try {
    const ticker = await binance.prices("BTCUSDT");
    lastPrice = parseFloat(ticker.BTCUSDT);
    // طباعة السعر في الـ Logs للتأكد من نجاح الاتصال
    console.log(`[${new Date().toLocaleTimeString()}] BTC Price: ${lastPrice}`);
  } catch (error) {
    console.error("❌ Price fetch error:", error.message);
  }
}

// تحديث السعر كل 5 ثوانٍ
setInterval(fetchPrice, 5000);
fetchPrice();

/* =========================
   🧠 STRATEGY ENGINE (Random RSI Simulation)
========================= */

function getSignal() {
  const rsi = 30 + Math.random() * 40; 
  if (rsi < 35) return 2; // إشارة شراء
  if (rsi > 70) return -2; // إشارة بيع
  return 0;
}

/* =========================
   📥 REAL ORDER EXECUTION
========================= */

async function openTrade() {
  try {
    if (!lastPrice) return;
    
    // سيقوم بالشراء بمبلغ 15 USDT (تأكد من توفرها في محفظة Spot)
    const amountInUSDT = 15;
    const quantity = (amountInUSDT / lastPrice).toFixed(5); 

    const order = await binance.marketBuy("BTCUSDT", quantity);

    account.openPositions.push({
      id: Date.now(),
      entry: lastPrice,
      qty: quantity,
      orderId: order.orderId,
      status: "OPEN"
    });
    console.log("🟢 SUCCESS: REAL BUY ORDER PLACED ON BINANCE");
  } catch (e) {
    console.error("❌ BUY ERROR:", e.body || e.message);
  }
}

async function closeTrade(position) {
  try {
    await binance.marketSell("BTCUSDT", position.qty);
    account.closedPositions.push({
      ...position,
      exit: lastPrice,
      status: "CLOSED"
    });
    console.log("🔴 SUCCESS: REAL SELL ORDER PLACED ON BINANCE");
  } catch (e) {
    console.error("❌ SELL ERROR:", e.body || e.message);
  }
}

/* =========================
   🚀 BOT ENGINE
========================= */

function startBot() {
  if (account.running) return;
  account.running = true;
  console.log("🤖 Bot Engine Activated and Watching Markets...");

  setInterval(async () => {
    if (!lastPrice) return;
    const signal = getSignal();

    // تنفيذ الشراء
    if (signal > 1 && account.openPositions.length < 1) {
      await openTrade();
    }

    // إدارة الصفقات المفتوحة (جني أرباح أو وقف خسارة)
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

// 1. رابط التشغيل الرئيسي
app.get("/start", (req, res) => {
  startBot();
  res.send("<h1 style='color:green;'>Bot is now running LIVE! 🚀</h1><p>Check logs in Render to see activity.</p>");
});

// 2. رابط فحص الحالة والرصيد الحقيقي من بينانس
app.get("/status", async (req, res) => {
  try {
    const balance = await binance.balance();
    res.json({
      bot_running: account.running,
      current_btc_price: lastPrice,
      wallet_balance: balance,
      active_trades: account.openPositions,
      history: account.closedPositions
    });
  } catch (error) {
    res.status(500).json({ 
      error: "Binance Connection Failed", 
      message: "تأكد من تفعيل التداول الفوري وضغط زر حفظ في بينانس",
      details: error.message 
    });
  }
});

// 3. الصفحة الرئيسية لتجنب خطأ Cannot GET /
app.get("/", (req, res) => {
  res.send("<h1>Binance Bot Server is LIVE ✅</h1><p>Use /status to check balance or /start to begin trading.</p>");
});

/* =========================
   🚀 SERVER START
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server is active and listening on port ${PORT}`);
});
