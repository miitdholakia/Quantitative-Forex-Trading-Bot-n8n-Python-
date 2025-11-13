// NODE: Scorer_Structure (v1.1)
// DESC: Generates signals based on simple BOS/CHOCH logic using PDH/PDL.
// REQUIRES: data_1h, data_4h, data_daily, hist_atr_4h
// REQUIRES: ** `pdh` and `pdl` from srData **
// ---
// v1.1 FIXES:
// - Added data reversal fix for all TA calculations (fixes 'ema' bug).
// - Implemented robust pipSize fallback logic.
// - Corrected final indicator key to 'rsi_1h'.
// - Filled in all standard helper functions.

// --- Standard Helper Functions ---
function calculateRSI(data, period = 14) {
    if (!data || data.length < period + 1) return { rsi: null, error: 'Not enough RSI data' };
    let gains = 0;
    let losses = 0;
    // Calculate initial average gains and losses
    for (let i = 1; i <= period; i++) {
        const change = data[i].close - data[i - 1].close;
        if (change > 0) {
            gains += change;
        } else {
            losses -= change;
        }
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    // Smooth the RSI
    for (let i = period + 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        let gain = 0;
        let loss = 0;
        if (change > 0) {
            gain = change;
        } else {
            loss = -change;
        }
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return { rsi: 100 };
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return { rsi: rsi };
}

function calculateATR(data, period = 14) {
    if (!data || data.length < period + 1) return { atr: null, error: 'Not enough ATR data' };
    let trs = [];
    // Calculate True Ranges
    for (let i = 1; i < data.length; i++) {
        const high = parseFloat(data[i].high);
        const low = parseFloat(data[i].low);
        const prevClose = parseFloat(data[i - 1].close);
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        const trueRange = Math.max(tr1, tr2, tr3);
        trs.push(trueRange);
    }
    if (trs.length < period) return { atr: null, error: 'Not enough TR data for ATR' };
    
    // Initial ATR (SMA of first 'period' TRs)
    let initialAtr = 0;
    for (let i = 0; i < period; i++) {
        initialAtr += trs[i];
    }
    let atr = initialAtr / period;
    
    // Smooth the rest
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return { atr: atr };
}

function calculateEMA(data, period = 21) {
    if (!data || data.length < period) return { ema: null, error: 'Not enough EMA data' };
    const k = 2 / (period + 1);
    let ema = 0;
    // Calculate initial SMA
    for (let i = 0; i < period; i++) {
        ema += parseFloat(data[i].close);
    }
    ema /= period;
    // Calculate EMA for the rest
    for (let i = period; i < data.length; i++) {
        ema = (parseFloat(data[i].close) * k) + (ema * (1 - k));
    }
    return { ema: ema };
}

function computeAtr4hNorm(last_atr_4h, histATRArray) {
    if (last_atr_4h === null || last_atr_4h === undefined || !histATRArray || histATRArray.length < 20) {
        return null; // Not enough data
    }
    try {
        const sortedAtr = [...histATRArray].sort((a, b) => a - b);
        let rank = sortedAtr.findIndex(val => val >= last_atr_4h);
        if (rank === -1) {
            rank = sortedAtr.length;
        }
        const percentile = rank / sortedAtr.length;
        return percentile;
    } catch (e) {
        console.error("Error in computeAtr4hNorm:", e.message);
        return null;
    }
}

function normalizeOutput(out, pipSize = 0.0001) {
    const mapType = { 'market_structure': 'market_structure' }; // New type
    out.signalType = mapType[out.signalType] || out.signalType || 'market_structure';
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

// --- Main Strategy Logic ---
if (items.length < 3) {
    throw new Error("Scorer (Structure) expects 3 items from AI_Merge node.");
}

// 1. Parse data
const candleData = items[0].json;
const srData     = items[1].json;
const { symbol, data_15m, data_1h, data_4h, data_daily, meta, hist_atr_4h } = candleData;
const { pdh, pdl } = srData; // This scorer NEEDS pdh/pdl

// --- v1.1 FIX: Added robust pipSize fallback ---
const pipSize = meta.pip_size || (symbol.includes('JPY') ? 0.01 : 0.0001);
// ---

let signal = 'flat';
let confidence = 0.0;
let reason = "No signal";

// 2. Check for minimum data
if (!data_1h || !data_4h || !data_daily || data_1h.length < 50 || data_4h.length < 50 || data_daily.length < 200) {
    return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'Not enough candle data' }, pipSize) }];
}
if (!pdh || !pdl) {
    return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'VETO: Missing PDH/PDL from srData.' }, pipSize) }];
}

// 3. Get All Indicators

// --- v1.1 FIX: Reverse data for TA calculations ---
const daily_data_for_ta = data_daily.slice().reverse();
const data_4h_for_ta = data_4h.slice().reverse();
const data_1h_for_ta = data_1h.slice().reverse();
// ---

// --- v1.1 FIX: Use reversed data for all TA calls ---
const daily_ema_200 = calculateEMA(daily_data_for_ta, 200);
const last_daily_price = parseFloat(data_daily[0].close);
const daily_above_200 = (daily_ema_200.ema && last_daily_price > daily_ema_200.ema) ? true : false;

const atr_4h = calculateATR(data_4h_for_ta, 14);
const atr_4h_norm = computeAtr4hNorm(atr_4h.atr, hist_atr_4h);

const atr_1h = calculateATR(data_1h_for_ta, 14);
const rsi_1h = calculateRSI(data_1h_for_ta, 14); // Use 1H for structure confirmation
// ---

const last_price = parseFloat(data_1h[0].close);
const atr_1h_pips = (atr_1h.atr && pipSize) ? Math.round(atr_1h.atr / pipSize) : 20;

if (!atr_1h.atr || !rsi_1h.rsi) {
    return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'Failed to calculate ATR/RSI.' }, pipSize) }];
}

// 4. Market Structure Logic (BOS/CHOCH)
const htf_bias = daily_above_200 ? 'Up' : 'Down';
const slPips = Math.max(15, Math.round(atr_1h_pips * 2.0)); // Wider SL for structure plays
let tpPips = Math.round(slPips * 1.5);

// Use previous candle close to confirm the break
const prev_price = parseFloat(data_1h[1].close);

if (htf_bias === 'Up') {
    // Look for Bullish BOS (Break of Structure)
    if (prev_price < pdh && last_price > pdh && rsi_1h.rsi > 55) {
        signal = 'buy';
        confidence = 0.70;
        reason = "HTF Up, Bullish BOS (Break of PDH) w/ Momentum";
    }
    // Look for Bearish CHOCH (Change of Character)
    else if (prev_price > pdl && last_price < pdl && rsi_1h.rsi < 45) {
        signal = 'sell';
        confidence = 0.65;
        reason = "HTF Up, Bearish CHOCH (Break of PDL)";
    }
} else if (htf_bias === 'Down') {
    // Look for Bearish BOS (Break of Structure)
    if (prev_price > pdl && last_price < pdl && rsi_1h.rsi < 45) {
        signal = 'sell';
        confidence = 0.70;
        reason = "HTF Down, Bearish BOS (Break of PDL) w/ Momentum";
    }
    // Look for Bullish CHOCH (Change of Character)
    else if (prev_price < pdh && last_price > pdh && rsi_1h.rsi > 55) {
        signal = 'buy';
        confidence = 0.65;
        reason = "HTF Down, Bullish CHOCH (Break of PDH)";
    }
}

// 5. Final Return
let finalJson = { 
    symbol, 
    signal, 
    confidence, 
    price: last_price,
    recommendedSLPips: signal !== 'flat' ? slPips : null,
    recommendedTPPips: signal !== 'flat' ? tpPips : null,
    reason,
    signalType: "market_structure",
    indicators: {
        // v1.1 FIX: Key 'rsi_1h' matches the data source 'rsi_1h.rsi'
        rsi_1h: rsi_1h.rsi,
        atr_1h: atr_1h.atr,
        daily_price_above_ema_200: daily_above_200,
        atr_4h_norm: atr_4h_norm,
        atr_1h_pips: atr_1h_pips
    },
    sr_data: srData,
    meta: meta
};

return [ { json: normalizeOutput(finalJson, pipSize) } ];
