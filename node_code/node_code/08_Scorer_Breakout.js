// NODE: Scorer_Breakout (v2.1 - PDH/PDL Break-and-Retest)
// VERSION: 2.1
// DESC: Fixed syntax errors (stray chars, missing comma).
//       - Waits for 15m break, then retest of PDH/PDL.
//       - Added structural SL (based on the broken level).
//       - Added structural TP (based on S1/R1 pivots).
//       - Added Session Filter (London/NY opens).
// INPUT: Expects 3 items from the AI_Merge node (Mode: Wait)
// - items[0]: Candle Data (from MTF Node)
// - items[1]: S/R Pivot Data (from S/R Filter)
// - items[2]: Quote Data (Unused)
// OUTPUT: A signal for the Trader node.

// --- Helper Functions (Unchanged) ---
function calculateRSI(data, period = 14) {
    if (!data || data.length < period + 1) return { rsi: 50, values: [] };
    const prices = data.map(d => parseFloat(d.close)).reverse();
    if (prices.length < period + 1) return { rsi: 50, values: [] };
    
    let gains = 0;
    let losses = 0;
    let rsiValues = [];

    for (let i = 1; i <= period; i++) {
        let change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    rsiValues.push(100 - (100 / (1 + (avgGain / avgLoss))));

    for (let i = period + 1; i < prices.length; i++) {
        let change = prices[i] - prices[i - 1];
        let gain = change > 0 ? change : 0;
        let loss = change < 0 ? -change : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        let rs = (avgLoss === 0) ? 100 : avgGain / avgLoss;
        rsiValues.push(100 - (100 / (1 + rs)));
    }
    
    return { rsi: rsiValues[rsiValues.length - 1], values: rsiValues };
}

function calculateATR(data, period = 14) {
    if (!data || data.length < period + 1) return { atr: null, values: [] };
    // FIX: Removed a stray underscore '_' from the next line
    const candles = [...data].reverse();
    let trValues = [];
    trValues.push(parseFloat(candles[0].high) - parseFloat(candles[0].low));

    for (let i = 1; i < candles.length; i++) {
        let h = parseFloat(candles[i].high);
        let l = parseFloat(candles[i].low);
        let prevClose = parseFloat(candles[i-1].close);
        let tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
        trValues.push(tr);
    }

    let atrValues = [];
    let sum = 0;
    for(let i=0; i < period; i++) sum += trValues[i];
    let firstAtr = sum / period;
    atrValues.push(firstAtr);
    
    let prevAtr = firstAtr;
    for(let i = period; i < trValues.length; i++) {
        let currentAtr = ((prevAtr * (period - 1)) + trValues[i]) / period;
        atrValues.push(currentAtr);
        prevAtr = currentAtr;
    }

    return { atr: atrValues[atrValues.length - 1], values: atrValues };
}

function calculateEMA(data, period = 21) {
    if (!data || data.length < period) return { ema: null, values: [] };
    const prices = data.map(d => parseFloat(d.close)).reverse();
    let emaValues = [];
    const k = 2 / (period + 1); // Smoothing factor

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += prices[i];
    }
    let prevEma = sum / period;
    emaValues.push(prevEma);

    for (let i = period; i < prices.length; i++) {
        let ema = (prices[i] * k) + (prevEma * (1 - k));
        emaValues.push(ema);
        prevEma = ema;
    }

    return { ema: emaValues[emaValues.length - 1], values: emaValues };
}
// --- End Helpers ---


// --- Main Strategy Logic (B&R) ---
if (items.length < 3) {
    throw new Error("Scorer (B&R) expects 3 items from AI_Merge node.");
}

// 1. Parse data
const candleData = items[0].json;
const srData     = items[1].json;
const { symbol, data_5m, data_15m, data_1h, data_4h, meta } = candleData;
const { pivots, pdh, pdl } = srData; // Pivots (R1, S1) are now used
const pipSize = meta.pip_size || 0.01;

let signal = 'flat';
let confidence = 0.0;
let reason = "No signal";
let htf_bias = 'flat';

// 2. Check for minimum data
// We now need at least 2 15m candles for B&R logic
if (data_4h.length < 55 || data_15m.length < 30 || data_1h.length < 30 || !pdh || !pdl) {
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason: 'Not enough data for B&R (needs candles + PDH/PDL)', sr_data: srData } }];
}

// 3. Get All Indicators
const rsi_4h      = calculateRSI(data_4h, 14);
const ema_4h      = calculateEMA(data_4h, 50);
const rsi_15m     = calculateRSI(data_15m, 14);
const atr_1h      = calculateATR(data_1h, 14);
const atr_15m     = calculateATR(data_15m, 14); // For volatility check

// Check if indicators are valid
if (!rsi_4h.rsi || !ema_4h.ema || !rsi_15m.rsi || !atr_1h.atr || !atr_15m.atr) {
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason: 'Indicator calculation failed, not enough data.', sr_data: srData } }];
}

const last_rsi_4h    = rsi_4h.rsi;
const last_ema_4h    = ema_4h.ema;
const last_price_4h  = parseFloat(data_4h[0].close);
const last_rsi_15m   = rsi_15m.rsi;
const last_price_15m = parseFloat(data_15m[0].close);
const prev_close_15m = parseFloat(data_15m[1].close); // Get previous close for B&R
const last_atr_1h    = atr_1h.atr;

// --- FILTER 1: VOLATILITY (Unchanged) ---
const VOLATILITY_SPIKE_MULT = 3.0;
const current_15m_candle = data_15m[0];
const current_15m_range = parseFloat(current_15m_candle.high) - parseFloat(current_15m_candle.low);
const avg_15m_range = atr_15m.atr;

if (current_15m_range > (avg_15m_range * VOLATILITY_SPIKE_MULT)) {
    reason = `VETO (B&R): Volatility spike detected. Market unsafe.`;
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, sr_data: srData } }];
}

// 4. Determine Trend Bias (4-Hour Chart) - Simplified
if (last_price_4h > last_ema_4h) {
    htf_bias = 'long';
} else if (last_price_4h < last_ema_4h) {
    htf_bias = 'short';
}

// --- FILTER 2: SESSION FILTER (NEW) ---
const currentDate = new Date(data_15m[0].time * 1000);
const currentHour = currentDate.getUTCHours();
// Only trade London Open (7-10) or NY Open (12-15)
const isHighLiquidity = (currentHour >= 7 && currentHour <= 10) || (currentHour >= 12 && currentHour <= 15);

// 5. Look for Break-and-Retest (B&R) Entry (15-Min Chart)
const sr_zone_amount = last_atr_1h * 0.25; // 25% of 1H ATR for retest zone & SL buffer
const retest_rsi_buy  = 55; // For B&R, we want RSI to show momentum is *holding*
const retest_rsi_sell = 45;

if (htf_bias === 'long' && isHighLiquidity) {
    // Look for a Break-and-Retest of PDH
    const hasBrokenPDH = prev_close_15m > pdh; // 1. Did we *break* above PDH?
    const isRetestingPDH = last_price_15m < (pdh + sr_zone_amount) && last_price_15m > pdh; // 2. Is price *retesting* the level?
    const hasMomentum = last_rsi_15m > retest_rsi_buy; // 3. Is momentum holding > 55?

    if (hasBrokenPDH && isRetestingPDH && hasMomentum) {
        signal = 'buy';
        reason = "4H Trend Up, 15m Break-and-Retest of PDH in high-liquidity session.";
        confidence = 0.85; // B&R is a high-confidence setup
    }

} else if (htf_bias === 'short' && isHighLiquidity) {
    // Look for a Break-and-Retest of PDL
    const hasBrokenPDL = prev_close_15m < pdl; // 1. Did we *break* below PDL?
    const isRetestingPDL = last_price_15m > (pdl - sr_zone_amount) && last_price_15m < pdl; // 2. Is price *retesting* the level?
    const hasMomentum = last_rsi_15m < retest_rsi_sell; // 3. Is momentum holding < 45?

    if (hasBrokenPDL && isRetestingPDL && hasMomentum) {
        signal = 'sell';
        reason = "4H Trend Down, 15m Break-and-Retest of PDL in high-liquidity session.";
        confidence = 0.85;
    }
}

// 6. No Entry Found
if (signal === 'flat') {
    reason = `HTF bias ${htf_bias}. No B&R setup (Session: ${isHighLiquidity}, 15m RSI: ${last_rsi_15m.toFixed(1)})`;
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, sr_data: srData } }];
}

// 7. Calculate Structural SL & TP
const currentPrice = parseFloat(data_15m[0].close);
let recommendedSLPrice;
let recommendedTPPrice;

if (signal === 'buy') {
    // SL is *below* the PDH (the broken structure)
    recommendedSLPrice = pdh - sr_zone_amount; 
    // TP is the next major pivot
    recommendedTPPrice = pivots.R1; 

    // Sanity check for TP: Ensure TP is at least 1:1 R:R
    if (recommendedTPPrice && (recommendedTPPrice < currentPrice + (currentPrice - recommendedSLPrice))) {
        recommendedTPPrice = pivots.R2 || recommendedTPPrice; // Target R2 if R1 is too close
    }
    if (!recommendedTPPrice) reason += " | Warning: No R1/R2 pivot for TP.";

} else { // signal === 'sell'
    // SL is *above* the PDL (the broken structure)
    recommendedSLPrice = pdl + sr_zone_amount;
    // TP is the next major pivot
    recommendedTPPrice = pivots.S1;
    // FIX: Removed a stray 's' from the next line
    
    // Sanity check for TP: Ensure TP is at least 1:1 R:R
    if (recommendedTPPrice && (recommendedTPPrice > currentPrice - (recommendedSLPrice - currentPrice))) {
        recommendedTPPrice = pivots.S2 || recommendedTPPrice; // Target S2 if S1 is too close
    }
    if (!recommendedTPPrice) reason += " | Warning: No S1/S2 pivot for TP.";
}

// Final check: Veto if no valid TP was found
if (!recommendedTPPrice) {
    reason = `VETO: ${signal} triggered but no valid S/R pivot found for Take Profit.`;
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, sr_data: srData } }];
}

// Calculate SL pips
const slDistance = Math.abs(currentPrice - recommendedSLPrice);
const recommendedSLPips = Math.max(20, Math.round(slDistance / pipSize)); // Min 20 pips

return [{ 
    json: { 
        symbol, 
        signal, 
        confidence, 
        price: currentPrice,
        recommendedSLPips,
        recommendedSLPrice, // NEW: Added a precise SL price
        recommendedTPPrice, // NEW: Added a precise TP price
        reason,
        signalType: "break-and-retest", // NEW: Strategy name
        indicators: {
            rsi_4h: last_rsi_4h,
            rsi_15m: last_rsi_15m,
            atr_1h: last_atr_1h,
            // FIX: Added a missing comma to the next line
            isHighLiquidity // NEW: Added session status
        },
        sr_data: srData,
        meta: meta
    }
}];
