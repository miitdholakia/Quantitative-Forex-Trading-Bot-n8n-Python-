// NODE: Scorer_VWAP (v1.0)
// DESC: Generates signals based on VWAP bias.
// REQUIRES: data_1h, data_15m, data_daily, hist_atr_4h
// REQUIRES: ** `volume` and `typical` (HLC/3) on candle objects **
// --- BLUEPRINT PATCHES APPLIED (Item 3, 4, 5, 12) ---
// NEW v1.0: Provides 'vwap_bias' signalType

// --- Standard Helper Functions ---
function calculateRSI(data, period = 14) { /* ... (Same as other scorers) ... */ }
function calculateATR(data, period = 14) { /* ... (Same as other scorers) ... */ }
function calculateEMA(data, period = 21) { /* ... (Same as other scorers) ... */ }
function computeAtr4hNorm(last_atr_4h, histATRArray) { /* ... (Same as other scorers) ... */ }
function normalizeOutput(out, pipSize = 0.0001) {
    const mapType = { 'vwap_bias': 'vwap_bias' }; // New type
    out.signalType = mapType[out.signalType] || out.signalType || 'vwap_bias';
    out.confidence = Math.max(0, Math.min(1, Number(out.confidence || 0)));
    out.recommendedSLPips = out.recommendedSLPips ? Math.round(out.recommendedSLPips) : null;
    out.recommendedTPPips = out.recommendedTPPips ? Math.round(out.recommendedTPPips) : null;
    out.indicators = out.indicators || {};
    if (out.indicators.atr_1h_pips == null && out.indicators.atr_1h) {
        out.indicators.atr_1h_pips = Math.round(out.indicators.atr_1h / pipSize);
    }
    if (out.indicators.daily_price_above_ema_200 == null) { out.indicators.daily_price_above_ema_200 = null; }
    if (out.indicators.atr_4h_norm == null) { out.indicators.atr_4h_norm = null; }
    return out;
}
// --- End Standard Helpers ---

// --- NEW VWAP HELPER ---
/**
 * Calculates (Volume Weighted Average Price) for a given set of candles.
 * Assumes candles are in DESCENDING order (newest first).
 * Assumes candle objects have `typical` (HLC/3) and `volume` properties.
 */
function calculateVWAP(data) {
    if (!data || data.length === 0 || !data[0].typical || !data[0].volume) {
        return null; // Not enough data or missing required fields
    }
    
    // Reverse to calculate from oldest to newest for a cumulative sum
    const candles = [...data].reverse();
    
    let cumulativeTypicalVolume = 0;
    let cumulativeVolume = 0;
    
    for (const candle of candles) {
        const typicalPrice = parseFloat(candle.typical);
        const volume = parseFloat(candle.volume);
        
        if (isNaN(typicalPrice) || isNaN(volume)) continue;
        
        cumulativeTypicalVolume += typicalPrice * volume;
        cumulativeVolume += volume;
    }
    
    if (cumulativeVolume === 0) return null;
    return cumulativeTypicalVolume / cumulativeVolume;
}

// --- Main Strategy Logic ---
if (items.length < 3) {
    throw new Error("Scorer (VWAP) expects 3 items from AI_Merge node.");
}

// 1. Parse data
const candleData = items[0].json;
const srData     = items[1].json;
const { symbol, data_15m, data_1h, data_4h, data_daily, meta, hist_atr_4h } = candleData;
const pipSize = meta.pip_size || 0.01;

let signal = 'flat';
let confidence = 0.0;
let reason = "No signal";

// 2. Check for minimum data
if (!data_1h || !data_15m || !data_4h || !data_daily || data_1h.length < 24 || data_15m.length < 24 || data_4h.length < 50 || data_daily.length < 200) {
    return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'Not enough candle data' }, pipSize) }];
}
// CRITICAL CHECK: Check for volume and typical price
if (!data_15m[0].volume || !data_15m[0].typical || !data_1h[0].volume || !data_1h[0].typical) {
    return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'VETO: Candle data is missing `volume` or `typical` properties.' }, pipSize) }];
}

// 3. Get All Indicators
// --- (Item 12) Standard indicators for Trader Node ---
const daily_ema_200 = calculateEMA(data_daily, 200);
const last_daily_price = parseFloat(data_daily[0].close);
const daily_above_200 = (daily_ema_200.ema && last_daily_price > daily_ema_200.ema) ? true : false;
const atr_4h = calculateATR(data_4h, 14);
const atr_4h_norm = computeAtr4hNorm(atr_4h.atr, hist_atr_4h);
const atr_1h = calculateATR(data_1h, 14);
const rsi_4h = calculateRSI(data_4h, 14);
// --- End Standard ---

const vwap_1h = calculateVWAP(data_1h);
const vwap_15m = calculateVWAP(data_15m);
const last_price = parseFloat(data_15m[0].close);
const atr_1h_pips = (atr_1h.atr && pipSize) ? Math.round(atr_1h.atr / pipSize) : 20;
const vwap_zone = (atr_1h.atr || 0) * 0.25;

if (!vwap_1h || !vwap_15m || !atr_1h.atr) {
    return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'Failed to calculate VWAP or ATR.' }, pipSize) }];
}

// 4. VWAP Bias Logic
const htf_bias = daily_above_200 ? 'Up' : 'Down';
const slPips = Math.max(15, Math.round(atr_1h_pips * 1.5));
let tpPips = Math.round(slPips * 1.8); // Default TP

if (htf_bias === 'Up' && last_price > vwap_1h) {
    // HTF Bias is Up, 1H price is above 1H VWAP (Bullish)
    // Look for a pullback to the 15m VWAP
    if (last_price < (vwap_15m + vwap_zone) && last_price > (vwap_15m - vwap_zone)) {
        signal = 'buy';
        confidence = 0.65;
        reason = "HTF Up, Price > 1H VWAP, Pullback to 15m VWAP support";
    }
} else if (htf_bias === 'Down' && last_price < vwap_1h) {
    // HTF Bias is Down, 1H price is below 1H VWAP (Bearish)
    // Look for a pullback to the 15m VWAP
    if (last_price > (vwap_15m - vwap_zone) && last_price < (vwap_15m + vwap_zone)) {
        signal = 'sell';
        confidence = 0.65;
        reason = "HTF Down, Price < 1H VWAP, Pullback to 15m VWAP resistance";
    }
}

// 5. Final Return
let finalJson = { 
    symbol, 
    signal, 
    confidence, 
    price: last_price,
    recommendedSLPips: slPips,
    recommendedTPPips: tpPips,
    reason,
    signalType: "vwap_bias",
    indicators: {
        rsi_4h: rsi_4h.rsi,
        atr_1h: atr_1h.atr,
        daily_price_above_ema_200: daily_above_200,
        atr_4h_norm: atr_4h_norm,
        atr_1h_pips: atr_1h_pips,
        vwap_1h: vwap_1h,
        vwap_15m: vwap_15m
    },
    sr_data: srData,
    meta: meta
};

return [ { json: normalizeOutput(finalJson, pipSize) } ];
