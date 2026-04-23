import express from "express";
import Binance from "node-binance-api";
import { RSI, EMA, BollingerBands } from "technicalindicators";

const app = express();
app.use(express.json());

// --- 1. إعداد الاتصال ببينانس ---
const binance = new Binance().options({
  APIKEY: 'ضع_مفتاحك_هنا', 
  APISECRET: 'ضع_السكرت_هنا',
  family: 4,              // مهم جداً لتجنب مشاكل الـ IPv6
  useServerTime: true,
  recvWindow: 60000
});

// --- 2. متغيرات الحالة (State Management) ---
const CONFIG = {
  symbol: "BTCUSDT",
  buyAmountUSDT: 15,      // مبلغ كل صفقة
  maxTrades: 3,           // أقصى عدد صفقات مفتوحة
  stopLossLimit: -2.0,    // وقف خسارة عند هبوط 2%
  takeProfitLimit: 4.0    // جني ربح عند صعود 4%
};

let activeTrades = [];    // الصفقات المفتوحة الآن
let tradeHistory = [];    // سجل الصفقات المنتهية
let engineInterval = null;

// --- 3. المحرك التحليلي (Logic) ---
async function tradeLogic() {
  try {
    const candles = await binance.candlesticks(CONFIG.symbol, "5m");
    const closes = candles.map(c => parseFloat(c[4]));
    const currentPrice = closes[closes.length - 1];

    if (closes.length < 50) return;

    // حساب المؤشرات
    const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
    const ema50 = EMA.calculate({ values: closes, period: 50 }).pop();
    const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).pop();

    // أ- منطق الدخول (شراء آلي)
    const isEntryZone = currentPrice > ema50 && rsi < 35 && currentPrice <= bb.lower;
    if (isEntryZone && activeTrades.length < CONFIG.maxTrades) {
      const qty = (CONFIG.buyAmountUSDT / currentPrice).toFixed(5);
      const order = await binance.marketBuy(CONFIG.symbol, qty);
      
      activeTrades.push({
        id: order.orderId || Date.now(),
        entryPrice: currentPrice,
        quantity: qty,
        time: new Date().toLocaleTimeString(),
        status: "ACTIVE"
      });
      console.log("✅ تمت صفقة شراء آلية");
    }

    // ب- إدارة الصفقات المفتوحة (خروج/تحديث)
    for (let i = activeTrades.length - 1; i >= 0; i--) {
      let trade = activeTrades[i];
      const profit = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      
      trade.currentProfit = profit.toFixed(2) + "%";

      // خروج (جني ربح أو وقف خسارة)
      if (profit >= CONFIG.takeProfitLimit || profit <= CONFIG.stopLossLimit) {
        await binance.marketSell(CONFIG.symbol, trade.quantity);
        trade.exitPrice = currentPrice;
        trade.result = profit >= 0 ? "PROFIT" : "LOSS";
        trade.exitTime = new Date().toLocaleTimeString();
        
        tradeHistory.unshift(trade); // إضافة للسجل
        activeTrades.splice(i, 1);   // إزالة من النشط
        console.log(`🛑 إغلاق صفقة على ${trade.result}`);
      }
    }
  } catch (err) {
    console.error("Engine Error:", err.message);
  }
}

// --- 4. الروابط الخاصة بتطبيق الأندرويد (API) ---

// أ- تشغيل/إيقاف البوت
app.get("/control/:action", (req, res) => {
  const { action } = req.params;
  if (action === "start") {
    if (!engineInterval) engineInterval = setInterval(tradeLogic, 20000);
    return res.json({ message: "البوت يعمل الآن" });
  } else {
    clearInterval(engineInterval);
    engineInterval = null;
    return res.json({ message: "تم إيقاف البوت" });
  }
});

// ب- حالة لوحة التحكم (Dashboard)
app.get("/dashboard", async (req, res) => {
  try {
    const balance = await binance.balance();
    res.json({
      usdt: balance.USDT ? balance.USDT.available : 0,
      activeTrades: activeTrades,
      isRunning: !!engineInterval
    });
  } catch (e) { res.status(500).send("Error fetching data"); }
});

// ج- سجل الصفقات (History)
app.get("/history", (req, res) => {
  res.json(tradeHistory);
});

// د- شراء يدوي من التطبيق
app.post("/manual-buy", async (req, res) => {
  try {
    const { amount } = req.body;
    const ticker = await binance.prices(CONFIG.symbol);
    const price = parseFloat(ticker[CONFIG.symbol]);
    const qty = (amount / price).toFixed(5);
    await binance.marketBuy(CONFIG.symbol, qty);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`محرك التداول جاهز على منفذ ${PORT}`));
