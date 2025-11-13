// NODE: Scorer (v4.7 - AI Agent w/ Volatility, S/R, TP & Pullback Fix)
// FIX: Corrected S/R zone logic to use price amount (ATR * mult) instead of pips.
// NEW v4.7: Added dynamic 4H EMA to S/R filter.
// NEW v4.7: Added "shallow_pullback" entry logic to fill 15m RSI dead-zone.
// NEW v4.7: Added dynamic Take Profit (TP) calculation based on next S/R level or 1.5 R:R.
// INPUT: Expects 3 items from the AI_Merge node (Mode: Wait)
// - items[0]: Candle Data (from MTF Node)
// - items[1]: S/R Pivot Data (from S/R Filter)
// - items[2]: Quote Data (This is unused for spread, but required by the merge)
// OUTPUT: A final, context-aware signal for the Trader node.

// --- CONFIGURATION ---
const VOLATILITY_SPIKE_MULT = 3.0; // Veto if current candle range is 3x the 15m ATR
const SR_ZONE_ATR_MULT = 0.25;     // S/R zone = 25% of 1H ATR
// --- End Configuration ---


// --- Technical Indicator Helpers ---
// (All helper functions: calculateRSI, calculateATR, calculateEMA remain unchanged)
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
    if (avgLoss === 0) rsiValues.push(100);
    else rsiValues.push(100 - (100 / (1 + (avgGain / avgLoss))));

    for (let i = period + 1; i < prices.length; i++) {
        let change = prices[i] - prices[i - 1];
        let gain = change > 0 ? change : 0;
        let loss = change < 0 ? -change : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        if (avgLoss === 0) rsiValues.push(100);
        else rsiValues.push(100 - (100 / (1 + (avgGain / avgLoss))));
    }
    
    return { rsi: rsiValues[rsiValues.length - 1], values: rsiValues };
}

function calculateATR(data, period = 14) {
    if (!data || data.length < period + 1) return { atr: null, values: [] };
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


// --- Main Strategy Logic (v4.7) ---
if (items.length < 3) {
  throw new Error("Scorer (AI Agent) expects 3 items from AI_Merge node. Did you add the AI_Merge node?");
}

// 1. Parse all our data streams
const candleData = items[0].json;
const srData     = items[1].json;
// items[2] (Quote Data) is ignored.

// Get candle data
const { symbol, data_5m, data_15m, data_1h, data_4h, meta } = candleData;
// Get S/R data
const { pivots, pdh, pdl } = srData;
// Get pip size
const pipSize = meta.pip_size || 0.01;

let signal = 'flat';
let confidence = 0.0;
let recommendedSLPips = 40; // Default for XAU
let recommendedTPPips = 60; // Default for XAU (will be overwritten)
let reason = "No signal";
let htf_bias = 'flat';
let market_data_log = { info: "Spread filter disabled. Quote node not providing bid/ask." };

// 2. Check for minimum candle data
if (data_4h.length < 55 || data_15m.length < 30 || data_1h.length < 30) {
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason: 'Not enough data for EMAs/RSI', market_data: market_data_log, sr_data: srData } }];
}

// 3. Get All Indicators
const rsi_4h   = calculateRSI(data_4h, 14);
const ema_4h   = calculateEMA(data_4h, 50);
const rsi_15m  = calculateRSI(data_15m, 14);
const ema_15m  = calculateEMA(data_15m, 21);
const atr_1h   = calculateATR(data_1h, 14);
const atr_15m  = calculateATR(data_15m, 14); // For Volatility Filter

// Check if indicators are valid
if (!rsi_4h.rsi || !ema_4h.ema || !rsi_15m.rsi || !ema_15m.ema || !atr_1h.atr || !atr_15m.atr) {
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason: 'Indicator calculation failed, not enough data.', market_data: market_data_log, sr_data: srData } }];
}

const last_rsi_4h    = rsi_4h.rsi;
const last_ema_4h    = ema_4h.ema;
const last_price_4h  = parseFloat(data_4h[0].close);
const last_rsi_15m   = rsi_15m.rsi;
const last_ema_15m   = ema_15m.ema;
const last_price_15m = parseFloat(data_15m[0].close);
const last_atr_1h    = atr_1h.atr;
const last_atr_15m   = atr_15m.atr;


// --- FILTER 1: VOLATILITY (NEWS FILTER) ---
const current_15m_candle = data_15m[0];
const current_15m_range = parseFloat(current_15m_candle.high) - parseFloat(current_15m_candle.low);
const avg_15m_range = last_atr_15m;

if (current_15m_range > (avg_15m_range * VOLATILITY_SPIKE_MULT)) {
  reason = `VETO: Volatility spike detected. 15m range (${current_15m_range.toFixed(2)}) > ${VOLATILITY_SPIKE_MULT}x ATR (${avg_15m_range.toFixed(2)}). Market unsafe.`;
  return [{ json: { symbol, signal: 'flat', confidence: 0, reason, market_data: market_data_log, sr_data: srData } }];
}
// --- End Volatility Filter ---


// 4. Determine Trend Bias (4-Hour Chart)
if (last_price_4h > last_ema_4h && last_rsi_4h > 52) {
    htf_bias = 'long';
} else if (last_price_4h < last_ema_4h && last_rsi_4h < 48) {
    htf_bias = 'short';
} else {
    reason = `HTF chop (4H Price vs 50EMA, 4H RSI: ${last_rsi_4h.toFixed(1)})`;
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, market_data: market_data_log, sr_data: srData } }];
}

// 5. Look for LTF Entry (15-Min Chart)
let entrySignal = false;
let baseConfidence = 0.5; // Start at 50% for a valid setup
let signalType = "none";
reason = "No signal"; // Reset reason

if (htf_bias === 'long') {
    // --- Signal 1: Momentum/Continuation ---
    if (last_price_15m > last_ema_15m && last_rsi_15m > 55) {
        signal = 'buy';
        entrySignal = true;
        signalType = 'momentum';
        reason = "4H Trend Up, 15m Momentum (RSI > 55)";
        baseConfidence += 0.15; 
        if (last_rsi_4h > 60) baseConfidence += 0.15; 
        if (last_rsi_15m > 65) baseConfidence += 0.10; 
    }
    // --- Signal 2: Mean-Reversion/Pullback ---
    else if (last_rsi_15m < 35) {
        signal = 'buy';
        entrySignal = true;
        signalType = 'reversion';
        reason = "4H Trend Up, 15m Pullback (RSI < 35)";
        if (last_rsi_4h > 60) baseConfidence += 0.10; 
        if (last_rsi_15m < 25) baseConfidence += 0.20; 
    }
    // --- IMPROVEMENT #1: Shallow Pullback Entry ---
    else if (last_price_15m <= last_ema_15m && last_rsi_15m > 40) {
        signal = 'buy';
        entrySignal = true;
        signalType = 'shallow_pullback';
        reason = "4H Trend Up, 15m Pullback to 21-EMA";
        baseConfidence = 0.6; // This is a high-quality signal
        if (last_rsi_4h > 60) baseConfidence += 0.15;
    }
    // --- END IMPROVEMENT #1 ---

} else if (htf_bias === 'short') {
    // --- Signal 1: Momentum/Continuation ---
    if (last_price_15m < last_ema_15m && last_rsi_15m < 45) {
        signal = 'sell';
        entrySignal = true;
        signalType = 'momentum';
        reason = "4H Trend Down, 15m Momentum (RSI < 45)";
        baseConfidence += 0.15;
        if (last_rsi_4h < 40) baseConfidence += 0.15;
        if (last_rsi_15m < 35) baseConfidence += 0.10;
    }
    // --- Signal 2: Mean-Reversion/Pullback ---
    else if (last_rsi_15m > 65) {
        signal = 'sell';
        entrySignal = true;
        signalType = 'reversion';
        reason = "4H Trend Down, 15m Pullback (RSI > 65)";
        if (last_rsi_4h < 40) baseConfidence += 0.10;
        if (last_rsi_15m > 75) baseConfidence += 0.20;
    }
    // --- IMPROVEMENT #1: Shallow Pullback Entry ---
    else if (last_price_15m >= last_ema_15m && last_rsi_15m < 60) {
        signal = 'sell';
        entrySignal = true;
        signalType = 'shallow_pullback';
        reason = "4H Trend Down, 15m Pullback to 21-EMA";
        baseConfidence = 0.6; // This is a high-quality signal
        if (last_rsi_4h < 40) baseConfidence += 0.15;
    }
    // --- END IMPROVEMENT #1 ---
}

// 6. No Entry Found
if (!entrySignal) {
    reason = `HTF bias ${htf_bias}, no 15m entry (15m RSI: ${last_rsi_15m.toFixed(1)})`;
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, market_data: market_data_log, sr_data: srData } }];
}

// --- FILTER 2: S/R (CONTEXT) ---
const sr_zone_amount = last_atr_1h * SR_ZONE_ATR_MULT; 
let srContextApplied = false;

// --- IMPROVEMENT #3: Define S/R Levels (Dynamic + Static) ---
let supportLevels = [];
let resistanceLevels = [];

if (pivots) {
     supportLevels.push(pivots.s1, pivots.s2, pivots.s3, pdl, pivots.p);
     resistanceLevels.push(pivots.r1, pivots.r2, pivots.r3, pdh, pivots.p);
}

// Add dynamic HTF EMA based on bias
if (htf_bias === 'long') {
    supportLevels.push(last_ema_4h); // 4H EMA is support
} else if (htf_bias === 'short') {
    resistanceLevels.push(last_ema_4h); // 4H EMA is resistance
}

// Filter out any null/undefined values from the arrays
supportLevels = supportLevels.filter(Boolean);
resistanceLevels = resistanceLevels.filter(Boolean);
// --- END IMPROVEMENT #3 ---


// Now, run the S/R context check using the enhanced arrays
if (signal === 'buy') {
  // Check for conflict: buying right into resistance
  for (const r of resistanceLevels) {
    if (r && last_price_15m > (r - sr_zone_amount) && last_price_15m < (r + sr_zone_amount)) {
      baseConfidence -= 0.3;
      reason += ` (Penalty: At Resistance ${r.toFixed(2)})`;
      srContextApplied = true;
      break; // Only apply one penalty
    }
  }
  // Check for confluence: buying at support
  if (!srContextApplied) { // Don't add bonus if we already added penalty
    for (const s of supportLevels) {
      if (s && last_price_15m > (s - sr_zone_amount) && last_price_15m < (s + sr_zone_amount)) {
        baseConfidence += 0.2;
        reason += ` (Bonus: At Support ${s.toFixed(2)})`;
        break; // Only apply one bonus
      }
    }
  }
} else if (signal === 'sell') {
  // Check for conflict: selling right into support
  for (const s of supportLevels) {
    if (s && last_price_15m > (s - sr_zone_amount) && last_price_15m < (s + sr_zone_amount)) {
      baseConfidence -= 0.3;
      reason += ` (Penalty: At Support ${s.toFixed(2)})`;
      srContextApplied = true;
      break; 
    }
  }
  // Check for confluence: selling at resistance
  if (!srContextApplied) {
    for (const r of resistanceLevels) {
      if (r && last_price_15m > (r - sr_zone_amount) && last_price_15m < (r + sr_zone_amount)) {
        baseConfidence += 0.2;
        reason += ` (Bonus: At Resistance ${r.toFixed(2)})`;
        break;
      }
    }
  }
}

// 7. Final Veto (if S/R logic made confidence too low)
confidence = Math.min(1.0, baseConfidence); // Cap at 100%
if (confidence < 0.1) { // Absolute minimum confidence
  reason += " (VETO: S/R context makes confidence too low)";
  return [{ json: { symbol, signal: 'flat', confidence: 0, reason, market_data: market_data_log, sr_data: srData } }];
}

// 8. Calculate SL, TP & Price
const currentPrice = parseFloat(data_15m[0].close);

// --- Calculate SL (Unchanged) ---
const slPipsFromATR = (last_atr_1h * 1.5) / pipSize;
recommendedSLPips = Math.max(20, Math.round(slPipsFromATR)); // Min 20 pips for XAU

// --- IMPROVEMENT #2: Calculate Dynamic TP ---
// Note: 'supportLevels' and 'resistanceLevels' are now enhanced from FILTER 2

if (signal === 'buy') {
    // Find the *nearest* resistance level *above* the current price
    const targets = resistanceLevels.filter(r => r > currentPrice);
    if (targets.length > 0) {
        const nearestTarget = Math.min(...targets);
        // Set TP just *before* the level (e.g., subtract half a zone)
        const targetPrice = nearestTarget - (sr_zone_amount / 2); 
        recommendedTPPips = (targetPrice - currentPrice) / pipSize;
    }
} else if (signal === 'sell') {
    // Find the *nearest* support level *below* the current price
    const targets = supportLevels.filter(s => s < currentPrice);
    if (targets.length > 0) {
        const nearestTarget = Math.max(...targets);
        // Set TP just *before* the level
        const targetPrice = nearestTarget + (sr_zone_amount / 2);
        recommendedTPPips = (currentPrice - targetPrice) / pipSize;
    }
}

// Ensure TP is at least a 1:1 R:R, otherwise, default to 1.5:1
if (!recommendedTPPips || recommendedTPPips < recommendedSLPips) {
    recommendedTPPips = Math.round(recommendedSLPips * 1.5); // Default to 1.5:1 R:R
} else {
    recommendedTPPips = Math.round(recommendedTPPips);
}
// --- END IMPROVEMENT #2 ---


// 9. Final Return
return [{ 
    json: { 
        symbol, 
        signal, 
        confidence, 
        price: currentPrice,
        recommendedSLPips,
        recommendedTPPips, // <-- ADDED
        reason,
        signalType,
        indicators: {
            rsi_4h: last_rsi_4h,
            ema_4h: last_ema_4h,
            rsi_15m: last_rsi_15m,
            ema_15m: last_ema_15m,
            atr_1h: last_atr_1h,
            atr_15m: last_atr_15m
        },
        market_data: market_data_log,
        sr_data: srData,
        meta: meta
    }
}];
