// NODE: Scorer_Liquidity (v1.1)
// DESC: Generates signals based on 1H Fair Value Gaps (FVG).
// REQUIRES: data_1h, data_4h, data_daily, hist_atr_4h
// ---
// v1.1 FIXES:
// - Corrected 'computeATRNorm' function call typo.
// - Corrected 'computeAtr4hNorm' argument (passes .atr value).
// - Corrected 'daily_above_200' variable mismatch (uses 'daily_200_ema').

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
    // We only need the most recent ATR, so we can use a simple moving average for the first one
    // and then smooth for the rest, but it's common to just smooth from the start.
    // Let's calculate the smoothed ATR.
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
        // Sort the historical ATR data
        const sortedAtr = [...histATRArray].sort((a, b) => a - b);
        
        // Find the rank of the current ATR
        // We find the first index where the sorted value is >= current ATR
        let rank = sortedAtr.findIndex(val => val >= last_atr_4h);
        
        // If not found (i.e., current ATR is highest), set rank to max
        if (rank === -1) {
            rank = sortedAtr.length;
        }
        
        // Normalize the rank to a 0-1 percentile
        const percentile = rank / sortedAtr.length;
        return percentile;
    } catch (e) {
        console.error("Error in computeAtr4hNorm:", e.message);
        return null;
    }
}

function normalizeOutput(out, pipSize = 0.0001) {
    const mapType = { 'liquidity': 'liquidity' }; // New type
    out.signalType = mapType[out.signalType] || out.signalType || 'liquidity';
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

// --- NEW LIQUIDITY HELPER ---
/**
 * Finds Fair Value Gaps (FVGs) in a candle array.
 * Assumes candles are in DESCENDING order (newest first).
 * Returns { bullish: [], bearish: [] }
 */
function findFVGs(data) {
    const bullishFVGs = [];
    const bearishFVGs = [];
    // Need at least 3 candles. i=0 is newest, i=1 is middle, i=2 is oldest.
    // We scan back in time.
    for (let i = 0; i < data.length - 2; i++) {
        const c1 = data[i + 2]; // Oldest (e.g., c1)
        const c2 = data[i + 1]; // Middle (e.g., c2)
        const c3 = data[i];   // Newest (e.g., c3)
        
        const c1_low = parseFloat(c1.low);
        const c1_high = parseFloat(c1.high);
        const c3_low = parseFloat(c3.low);
        const c3_high = parseFloat(c3.high);

        // Bullish FVG (gap between c1.high and c3.low)
        if (c1_high < c3_low) {
            bullishFVGs.push({ top: c3_low, bottom: c1_high, time: c3.time });
        }
        
        // Bearish FVG (gap between c1.low and c3.high)
        if (c1_low > c3_high) {
            bearishFVGs.push({ top: c1_low, bottom: c3_high, time: c3.time });
        }
    }
    return { bullish: bullishFVGs, bearish: bearishFVGs };
}

// --- Main Strategy Logic ---
if (items.length < 3) {
    throw new Error("Scorer (Liquidity) expects 3 items from AI_Merge node.");
}

// 1. Parse data
const candleData = items[0].json;
const srData     = items[1].json;
const { symbol, data_15m, data_1h, data_4h, data_daily, meta, hist_atr_4h } = candleData;

// --- v1.2 FIX: Added robust pipSize fallback ---
// Default to 0.0001 for most pairs, 0.01 for JPY pairs, if meta.pip_size is missing.
const pipSize = meta.pip_size || (symbol.includes('JPY') ? 0.01 : 0.0001);
// ---

let signal = 'flat';
let confidence = 0.0;
let reason = "No signal";

// 2. Check for minimum data
if (!data_1h || !data_4h || !data_daily || data_1h.length < 50 || data_4h.length < 50 || data_daily.length < 200) {
    return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'Not enough candle data' }, pipSize) }];
}

// 3. Get All Indicators

// variables data_daily, data_4h, data_1h, hist_atr_4h are already available

// --- Verification Step (Optional but Recommended) ---
console.log(`Received ${data_daily.length} daily candles for processing.`);
console.log(`Received ${data_4h.length} 4-hour candles for processing.`);

// --- FIX 2: Reverse data for TA calculations ---
// Most TA libraries require data to be in oldest-to-newest order.
const daily_data_for_ta = data_daily.slice().reverse();
const data_4h_for_ta = data_4h.slice().reverse();
const data_1h_for_ta = data_1h.slice().reverse();


// --- Run Calculations with Corrected Data ---

// Calculate Daily EMA
const daily_ema_200 = calculateEMA(daily_data_for_ta, 200);
const last_daily_price = parseFloat(data_daily[0].close);
// Safely check if daily_ema_200 and its .ema property exist before comparing
const daily_200_ema = (daily_ema_200 && daily_ema_200.ema && last_daily_price > daily_ema_200.ema) ? true : false;

// Calculate 4H Indicators
const atr_4h = calculateATR(data_4h_for_ta, 14);
const last_atr_4h_value = atr_4h ? atr_4h.atr : undefined;

// --- FIX 1: Corrected function name and argument ---
// From: computeATRNorm(atr_4h, hist_atr_4h)
// To:
const atr_4h_norm = computeAtr4hNorm(last_atr_4h_value, hist_atr_4h);
// ---
const rsi_4h = calculateRSI(data_4h_for_ta, 14);

// Calculate 1H Indicators
const atr_1h = calculateATR(data_1h_for_ta, 14);

// Get latest 1H price from the ORIGINAL array
const last_price = parseFloat(data_1h[0].close);
const atr_1h_value = atr_1h ? atr_1h.atr : undefined;

const atr_1h_pips = (atr_1h_value && pipSize) ? Math.round(atr_1h_value / pipSize) : 20;

if (!atr_1h_value) {
     return [{ json: normalizeOutput({ symbol, signal: 'flat', confidence: 0, reason: 'Could not calculate 1H ATR' }, pipSize) }];
}

// 4. Liquidity Logic
const fvgs = findFVGs(data_1h);

// --- FIX 2: Corrected variable name ---
// From: daily_above_200
// To:
const htf_bias = daily_200_ema ? 'Up' : 'Down';
// ---

const slPips = Math.max(15, Math.round(atr_1h_pips * 1.5));
let tpPips = Math.round(slPips * 1.8);

if (htf_bias === 'Up' && fvgs.bullish.length > 0) {
    // Find nearest Bullish FVG *below* current price
    const targets = fvgs.bullish
        .filter(fvg => fvg.top < last_price)
        .sort((a, b) => b.top - a.top); // Sort descending by top, nearest is [0]
    
    if (targets.length > 0) {
        const nearestFVG = targets[0];
        const distToFVG = last_price - nearestFVG.top;
        
        // If price is within 1 ATR of the FVG, consider it a pullback
        if (distToFVG > 0 && distToFVG < (atr_1h_value * 1.0)) {
            signal = 'buy';
            confidence = 0.60;
            reason = "HTF Up, Price pulling back to nearest 1H Bullish FVG";
            // Set SL below the FVG bottom
            const slPrice = nearestFVG.bottom - (atr_1h_value * 0.25);
            // Recalculate SLPips based on price
            const calculatedSLPips = Math.abs(last_price - slPrice) / pipSize;
            // Target 2R
            tpPips = Math.round(calculatedSLPips * 2.0);
        }
    }
} else if (htf_bias === 'Down' && fvgs.bearish.length > 0) {
    // Find nearest Bearish FVG *above* current price
    const targets = fvgs.bearish
        .filter(fvg => fvg.bottom > last_price)
        .sort((a, b) => a.bottom - b.bottom); // Sort ascending by bottom, nearest is [0]
        
    if (targets.length > 0) {
        const nearestFVG = targets[0];
        const distToFVG = nearestFVG.bottom - last_price;
        
        if (distToFVG > 0 && distToFVG < (atr_1h_value * 1.0)) {
            signal = 'sell';
            confidence = 0.60;
            reason = "HTF Down, Price pulling back to nearest 1H Bearish FVG";
            const slPrice = nearestFVG.top + (atr_1h_value * 0.25);
            // Recalculate SLPips based on price
            const calculatedSLPips = Math.abs(last_price - slPrice) / pipSize;
            // Target 2R
            tpPips = Math.round(calculatedSLPips * 2.0);
        }
    }
}

// 5. Final Return
let finalJson = { 
    symbol, 
    signal, 
    confidence, 
    price: last_price,
    recommendedSLPips: signal !== 'flat' ? slPips : null, // Use calculated SL if signal
    recommendedTPPips: signal !== 'flat' ? tpPips : null, // Use calculated TP if signal
    reason,
    signalType: "liquidity",
    indicators: {
        rsi_4h: rsi_4h.rsi,
        atr_1h: atr_1h.atr,
        // --- FIX 3: Corrected variable name ---
        // From: daily_above_200
        // To:
        daily_price_above_ema_200: daily_200_ema,
        // ---
        atr_4h_norm: atr_4h_norm,
        atr_1h_pips: atr_1h_pips
    },
    sr_data: srData,
    meta: meta
};

return [ { json: normalizeOutput(finalJson, pipSize) } ];
