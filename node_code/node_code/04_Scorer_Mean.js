// NODE: Scorer_Mean_Reversion (v1.2 - BB + StochRSI w/ ADX Filter)
// VERSION 1.2 CHANGES:
// - Replaced 4H RSI regime filter with 4H ADX for better ranging/trending detection.
// - Replaced 15M RSI entry with 15M Stochastic RSI for more sensitive entries.
// - Refactored confidence to be "reward-based" (no penalties).
// - Added Take Profit target (15m Middle Bollinger Band).
// - Implemented tiered S/R confluence bonuses (major/minor levels).

// INPUT: Expects 3 items from the AI_Merge node (Mode: Wait)
// - items[0]: Candle Data (from MTF Node)
// - items[1]: S/R Pivot Data (from S/R Filter)
// - items[2]: Quote Data (Unused)
// OUTPUT: A signal for the Trader node.

// --- CONFIGURATION ---
const VOLATILITY_SPIKE_MULT = 3.0;  // Veto if current candle range is 3x the 15m ATR
const SR_ZONE_ATR_MULT = 0.25;      // S/R zone = 25% of 1H ATR
const ADX_PERIOD = 14;              // ADX period for 4H regime filter
const ADX_TREND_THRESHOLD = 25;     // ADX value above which a trend is considered
const STOCH_RSI_PERIOD = 14;        // Stochastic RSI period
const STOCH_K_SMOOTH = 3;           // Stochastic RSI %K smoothing
const STOCH_D_SMOOTH = 3;           // Stochastic RSI %D smoothing
const BB_PERIOD = 20;               // Bollinger Bands period
const BB_STD_DEV = 2;               // Bollinger Bands standard deviation
const SR_BONUS_MINOR = 0.15;        // Confidence bonus for minor S/R (Central Pivot)
const SR_BONUS_MAJOR = 0.30;        // Confidence bonus for major S/R (S/R 1-3, PDH/L)
// --- End Configuration ---


// --- Technical Indicator Helpers (RSI, ATR, BB) ---
// [NOTE: calculateRSI, calculateATR, and calculateBollingerBands functions
// are unchanged from v1.1 and are assumed to be present here.]
function calculateRSI(data, period = 14) {
    if (!data || data.length < period + 1) return { rsi: 50, values: [] };
    const prices = data.map(d => parseFloat(d.close)).reverse();
    if (prices.length < period + 1) return { rsi: 50, values: [] };
    let gains = 0, losses = 0, rsiValues = [];
    for (let i = 1; i <= period; i++) {
        let change = prices[i] - prices[i - 1];
        if (change > 0) gains += change; else losses -= change;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    let rs = (avgLoss === 0) ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - (100 / (1 + rs)));
    for (let i = period + 1; i < prices.length; i++) {
        let change = prices[i] - prices[i - 1];
        let gain = change > 0 ? change : 0, loss = change < 0 ? -change : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        rs = (avgLoss === 0) ? 100 : avgGain / avgLoss;
        rsiValues.push(100 - (100 / (1 + rs)));
    }
    return { rsi: rsiValues[rsiValues.length - 1], values: rsiValues };
}

function calculateATR(data, period = 14) {
    if (!data || data.length < period + 1) return { atr: null, values: [] };
    const candles = [...data].reverse();
    let trValues = [parseFloat(candles[0].high) - parseFloat(candles[0].low)];
    for (let i = 1; i < candles.length; i++) {
        let h = parseFloat(candles[i].high), l = parseFloat(candles[i].low), prevClose = parseFloat(candles[i-1].close);
        trValues.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
    }
    let atrValues = [];
    let sum = trValues.slice(0, period).reduce((a, b) => a + b, 0);
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

function calculateBollingerBands(data, period = 20, stdDev = 2) {
    if (!data || data.length < period) return { upper: null, middle: null, lower: null };
    const prices = data.map(d => parseFloat(d.close)).reverse();
    let smaValues = [], stdDevValues = [];
    for (let i = period - 1; i < prices.length; i++) {
        const window = prices.slice(i - period + 1, i + 1);
        const sum = window.reduce((a, b) => a + b, 0);
        const sma = sum / period;
        smaValues.push(sma);
        const varianceSum = window.reduce((a, b) => a + Math.pow(b - sma, 2), 0);
        stdDevValues.push(Math.sqrt(varianceSum / period));
    }
    if (smaValues.length === 0) return { upper: null, middle: null, lower: null };
    const lastSMA = smaValues[smaValues.length - 1];
    const lastStdDev = stdDevValues[stdDevValues.length - 1];
    return { upper: lastSMA + (lastStdDev * stdDev), middle: lastSMA, lower: lastSMA - (lastStdDev * stdDev) };
}

// --- NEW HELPER: Stochastic RSI ---
function calculateStochasticRSI(data, rsiPeriod, stochPeriod, kSmooth, dSmooth) {
    const rsiResult = calculateRSI(data, rsiPeriod);
    const rsiValues = rsiResult.values;
    if (rsiValues.length < stochPeriod) return { k: null, d: null };

    let fastKValues = [];
    for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
        const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
        const currentRSI = rsiValues[i];
        const minRSI = Math.min(...window);
        const maxRSI = Math.max(...window);
        let fastK = 0;
        if ((maxRSI - minRSI) > 0) {
            fastK = 100 * (currentRSI - minRSI) / (maxRSI - minRSI);
        }
        fastKValues.push(fastK);
    }

    if (fastKValues.length < kSmooth) return { k: null, d: null };

    // Calculate Slow %K (SMA of Fast %K)
    let slowKValues = [];
    for (let i = kSmooth - 1; i < fastKValues.length; i++) {
        const window = fastKValues.slice(i - kSmooth + 1, i + 1);
        const sma = window.reduce((a, b) => a + b, 0) / kSmooth;
        slowKValues.push(sma);
    }
    
    if (slowKValues.length < dSmooth) return { k: slowKValues[slowKValues.length - 1], d: null };

    // Calculate Slow %D (SMA of Slow %K)
    let slowDValues = [];
    for (let i = dSmooth - 1; i < slowKValues.length; i++) {
        const window = slowKValues.slice(i - dSmooth + 1, i + 1);
        const sma = window.reduce((a, b) => a + b, 0) / dSmooth;
        slowDValues.push(sma);
    }

    return {
        k: slowKValues[slowKValues.length - 1],
        d: slowDValues[slowDValues.length - 1]
    };
}

// --- NEW HELPER: ADX (Average Directional Index) ---
function calculateADX(data, period = 14) {
    if (!data || data.length < period * 2) return { adx: null, plusDI: null, minusDI: null };
    const candles = [...data].reverse();
    
    let trValues = [], plusDM = [], minusDM = [];
    
    // First candle
    trValues.push(parseFloat(candles[0].high) - parseFloat(candles[0].low));
    plusDM.push(0);
    minusDM.push(0);

    // Calculate TR, +DM, -DM
    for (let i = 1; i < candles.length; i++) {
        let h = parseFloat(candles[i].high);
        let l = parseFloat(candles[i].low);
        let ph = parseFloat(candles[i-1].high);
        let pl = parseFloat(candles[i-1].low);
        let pc = parseFloat(candles[i-1].close);

        let tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        trValues.push(tr);

        let upMove = h - ph;
        let downMove = pl - l;
        
        plusDM.push((upMove > downMove && upMove > 0) ? upMove : 0);
        minusDM.push((downMove > upMove && downMove > 0) ? downMove : 0);
    }

    // Smooth TR, +DM, -DM (Wilder's Smoothing)
    let sumTR = trValues.slice(0, period).reduce((a, b) => a + b, 0);
    let sumPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
    let sumMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

    let smoothedTRs = [sumTR], smoothedPlusDMs = [sumPlusDM], smoothedMinusDMs = [sumMinusDM];
    
    for (let i = period; i < candles.length; i++) {
        let prevTR = smoothedTRs[smoothedTRs.length - 1];
        let prevPlusDM = smoothedPlusDMs[smoothedPlusDMs.length - 1];
        let prevMinusDM = smoothedMinusDMs[smoothedMinusDMs.length - 1];
        
        smoothedTRs.push(prevTR - (prevTR / period) + trValues[i]);
        smoothedPlusDMs.push(prevPlusDM - (prevPlusDM / period) + plusDM[i]);
        smoothedMinusDMs.push(prevMinusDM - (prevMinusDM / period) + minusDM[i]);
    }

    // Calculate +DI, -DI, DX, and ADX
    let plusDIs = [], minusDIs = [], dxValues = [], adxValues = [];
    
    for (let i = 0; i < smoothedTRs.length; i++) {
        let tr = smoothedTRs[i];
        let plusDI = (tr === 0) ? 0 : 100 * (smoothedPlusDMs[i] / tr);
        let minusDI = (tr === 0) ? 0 : 100 * (smoothedMinusDMs[i] / tr);
        plusDIs.push(plusDI);
        minusDIs.push(minusDI);
        
        let diSum = plusDI + minusDI;
        let dx = (diSum === 0) ? 0 : 100 * (Math.abs(plusDI - minusDI) / diSum);
        dxValues.push(dx);
    }

    // First ADX is an average of DX
    let sumDX = dxValues.slice(0, period).reduce((a, b) => a + b, 0);
    adxValues.push(sumDX / period);

    // Subsequent ADX use Wilder's smoothing
    for (let i = period; i < dxValues.length; i++) {
        let prevADX = adxValues[adxValues.length - 1];
        adxValues.push((prevADX * (period - 1) + dxValues[i]) / period);
    }

    return {
        adx: adxValues[adxValues.length - 1],
        plusDI: plusDIs[plusDIs.length - 1],
        minusDI: minusDIs[minusDIs.length - 1]
    };
}
// --- End Helpers ---


// --- Main Strategy Logic (Mean Reversion) ---
if (items.length < 3) {
    throw new Error("Scorer (Mean Reversion) expects 3 items from AI_Merge node.");
}

// 1. Parse all data streams
const candleData = items[0].json;
const srData     = items[1].json;
const { symbol, data_5m, data_15m, data_1h, data_4h, meta } = candleData;
const { pivots, pdh, pdl } = srData;
const pipSize = meta.pip_size || 0.01;

let signal = 'flat';
let confidence = 0.0;
let reason = "No signal";

// 2. Check for minimum candle data
if (data_4h.length < 50 || data_15m.length < 50 || data_1h.length < 30 || !pivots) { // Increased 4h/15m req for new indicators
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason: 'Not enough data for Mean Reversion (needs candles + pivots)', sr_data: srData } }];
}

// 3. Get All Indicators
const adx_4h        = calculateADX(data_4h, ADX_PERIOD); // For regime filter
const stochRSI_15m  = calculateStochasticRSI(data_15m, STOCH_RSI_PERIOD, STOCH_RSI_PERIOD, STOCH_K_SMOOTH, STOCH_D_SMOOTH); // For entry
const bb_15m        = calculateBollingerBands(data_15m, BB_PERIOD, BB_STD_DEV); // For entry signal
const atr_1h        = calculateATR(data_1h, 14); // For SL and S/R zone
const atr_15m       = calculateATR(data_15m, 14); // For Volatility Filter

// Check if indicators are valid
if (!adx_4h.adx || !stochRSI_15m.k || !bb_15m.upper || !atr_1h.atr || !atr_15m.atr) {
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason: 'Indicator calculation failed, not enough data.', sr_data: srData } }];
}

const last_adx_4h      = adx_4h.adx;
const last_stochRSI_k  = stochRSI_15m.k;
const last_price_15m   = parseFloat(data_15m[0].close);
const last_atr_1h      = atr_1h.atr;

// --- FILTER 1: VOLATILITY (NEWS FILTER) ---
const current_15m_candle = data_15m[0];
const current_15m_range = parseFloat(current_15m_candle.high) - parseFloat(current_15m_candle.low);
const avg_15m_range = atr_15m.atr;

if (current_15m_range > (avg_15m_range * VOLATILITY_SPIKE_MULT)) {
    reason = `VETO (Reversion): Volatility spike detected. Market unsafe.`;
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, sr_data: srData } }];
}
// --- End Volatility Filter ---

// 4. Define Regime (4-Hour Chart using ADX)
const isRanging = (last_adx_4h < ADX_TREND_THRESHOLD);
const isTrendingUp = (last_adx_4h >= ADX_TREND_THRESHOLD && adx_4h.plusDI > adx_4h.minusDI);
const isTrendingDown = (last_adx_4h >= ADX_TREND_THRESHOLD && adx_4h.minusDI > adx_4h.plusDI);

// 5. Look for LTF Entry (15-Min Chart using StochRSI)
const isOverbought = (last_stochRSI_k > 80);
const isOversold = (last_stochRSI_k < 20);
const atUpperBand = (last_price_15m > bb_15m.upper);
const atLowerBand = (last_price_15m < bb_15m.lower);

// --- REWARD-BASED CONFIDENCE ---
// Start with a low base confidence. This is the score for a
// risky counter-trend trade *before* S/R confluence.
let baseConfidence = 0.30; 

if (atLowerBand && isOversold) {
    // --- Buy Signal ---
    signal = 'buy';
    reason = "15m Oversold (StochRSI < 20) + Below Lower BB";
    
    if (isRanging) {
        confidence = baseConfidence + 0.4; // Strong bonus (0.7)
        reason += " (Context: 4H Ranging)";
    } else if (isTrendingUp) {
        confidence = baseConfidence + 0.3; // Good bonus: Pullback in uptrend (0.6)
        reason += " (Context: 4H Uptrend Pullback)";
    } else if (isTrendingDown) {
        confidence = baseConfidence; // No bonus: Fading strong downtrend (0.3)
        reason += " (Context: 4H Downtrend)";
    }

} else if (atUpperBand && isOverbought) {
    // --- Sell Signal ---
    signal = 'sell';
    reason = "15m Overbought (StochRSI > 80) + Above Upper BB";

    if (isRanging) {
        confidence = baseConfidence + 0.4; // Strong bonus (0.7)
        reason += " (Context: 4H Ranging)";
    } else if (isTrendingDown) {
        confidence = baseConfidence + 0.3; // Good bonus: Pullback in downtrend (0.6)
        reason += " (Context: 4H Downtrend Pullback)";
    } else if (isTrendingUp) {
        confidence = baseConfidence; // No bonus: Fading strong uptrend (0.3)
        reason += " (Context: 4H Uptrend)";
    }
}

// 6. No Entry Found
if (signal === 'flat') {
    reason = `No reversion signal (15m StochRSI: ${last_stochRSI_k.toFixed(1)})`;
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, sr_data: srData } }];
}

// --- FILTER 2: S/R (CONTEXT) ---
// Tiered bonus system for S/R confluence.
const sr_zone_amount = last_atr_1h * SR_ZONE_ATR_MULT;
let foundConfluence = false;

if (signal === 'buy') {
    // Check for confluence: buying at support
    const supportLevels = [
        { level: pdl, type: 'major' },
        { level: pivots.s1, type: 'major' },
        { level: pivots.s2, type: 'major' },
        { level: pivots.s3, type: 'major' },
        { level: pivots.p, type: 'minor' }
    ];
    
    for (const s of supportLevels) {
        if (s.level && last_price_15m > (s.level - sr_zone_amount) && last_price_15m < (s.level + sr_zone_amount)) {
            let bonus = (s.type === 'major') ? SR_BONUS_MAJOR : SR_BONUS_MINOR;
            confidence += bonus;
            reason += ` (Bonus: At ${s.type} Support ${s.level})`;
            foundConfluence = true;
            break; 
        }
    }
} else if (signal === 'sell') {
    // Check for confluence: selling at resistance
    const resistanceLevels = [
        { level: pdh, type: 'major' },
        { level: pivots.r1, type: 'major' },
        { level: pivots.r2, type: 'major' },
        { level: pivots.r3, type: 'major' },
        { level: pivots.p, type: 'minor' }
    ];

    for (const r of resistanceLevels) {
        if (r.level && last_price_15m > (r.level - sr_zone_amount) && last_price_15m < (r.level + sr_zone_amount)) {
            let bonus = (r.type === 'major') ? SR_BONUS_MAJOR : SR_BONUS_MINOR;
            confidence += bonus;
            reason += ` (Bonus: At ${r.type} Resistance ${r.level})`;
            foundConfluence = true;
            break;
        }
    }
}

// 7. Final Veto (if confidence is still too low)
confidence = Math.min(1.0, confidence); // Cap at 100%
if (confidence < baseConfidence) { // Veto if it's below the absolute minimum
    reason += " (VETO: Context makes confidence too low)";
    return [{ json: { symbol, signal: 'flat', confidence: 0, reason, sr_data: srData } }];
}

// 8. Calculate SL & TP
const currentPrice = parseFloat(data_15m[0].close);
// SL: Use 1.5x 1-HOUR ATR
const slPipsFromATR = (last_atr_1h * 1.5) / pipSize;
const recommendedSLPips = Math.max(20, Math.round(slPipsFromATR)); // Min 20 pips
// TP: Target the 15M Middle Bollinger Band (the "mean")
const recommendedTPPrice = bb_15m.middle;

return [{ 
    json: { 
        symbol, 
        signal, 
        confidence, 
        price: currentPrice,
        recommendedSLPips,
        recommendedTPPrice, // NEW: Added Take Profit target
        reason,
        signalType: "reversion", // Identify the strategy
        indicators: {
            adx_4h: last_adx_4h,
            adx_4h_plusDI: adx_4h.plusDI,
            adx_4h_minusDI: adx_4h.minusDI,
            stochRSI_15m_k: last_stochRSI_k,
            stochRSI_15m_d: stochRSI_15m.d,
            atr_1h: last_atr_1h,
            bb_15m_upper: bb_15m.upper,
            bb_15m_lower: bb_15m.lower,
            bb_15m_middle: bb_15m.middle
        },
        sr_data: srData,
        meta: meta
    }
}];
