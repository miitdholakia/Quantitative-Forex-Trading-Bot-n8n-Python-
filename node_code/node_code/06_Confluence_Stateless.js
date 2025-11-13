/*
 * STATELESS "SIGNAL CONFLUENCE" NODE (v1.4)
 *
 * This node's ONLY job is to:
 * 1. Receive all scorer signals.
 * 2. Run the Regime Router and Confluence Logic.
 * 3. Output a single, raw signal object (buy, sell, OR flat) for EVERY symbol.
 *
 * It is STATELESS. All state, risk, and order logic
 * will be handled by your Python MT5 bot.
 *
 * v1.4 LOGIC:
 * - Added `sl_price` and `tp_price` to the final output object.
 * - Added robust pip size calculation.
 *
 * v1.3 LOGIC:
 * - In a trend, it will take all 'OR' (Tech || Dynamic) signals WITH the trend.
 * - It will ALSO take 'reversion' signals AGAINST the trend.
 */

const allItems = $input.all();
const results = []; // This will hold our final raw signal(s)

// --- Configuration (Hardcoded for this node) ---
const regimeVolatilityThreshold = 0.7;
const TECHNICAL_SCORERS = ['momentum', 'reversion', 'breakout'];
const DYNAMIC_SCORERS = ['vwap_bias', 'liquidity', 'market_structure'];
// ---

// Group items by symbol
const grouped = {};
for (const it of allItems) {
  const d = (it && it.json) ? it.json : it;
  if (!d || !d.symbol) continue;
  if (!grouped[d.symbol]) grouped[d.symbol] = [];
  grouped[d.symbol].push(d);
}

// Process each symbol
for (const [symbol, arr] of Object.entries(grouped)) {
  try {
    if (!arr || arr.length === 0) {
      continue; // Skip if something is fundamentally wrong (no data)
    }

    // --- [Rec 1] Advanced Regime Router (Data Check) ---
    const firstValidSignal = arr.find(s => s.indicators && s.indicators.rsi_4h !== undefined);
    if (!firstValidSignal) {
      console.warn(`No valid indicator data for ${symbol}.`);
      results.push({ json: { symbol, signal: 'flat', reason: 'VETO: No valid indicator data from any scorer.' } });
      continue;
    }
    const indicators = firstValidSignal.indicators;
    const rsi_4h = indicators.rsi_4h;
    const daily_price_above_ema_200 = indicators.daily_price_above_ema_200;
    const atr_4h_norm = indicators.atr_4h_norm;

    if (rsi_4h === null || rsi_4h === undefined ||
      daily_price_above_ema_200 === null || daily_price_above_ema_200 === undefined ||
      atr_4h_norm === null || atr_4h_norm === undefined) {
      console.warn(`Regime Router: Missing required indicator data for ${symbol}.`);
      results.push({ json: { symbol, signal: 'flat', reason: 'VETO: Regime Router: Missing required indicator data (RSI, Daily EMA, ATR).' } });
      continue;
    }

    // 1. Determine HTF Trend
    let htf_trend = 'Neutral';
    if (daily_price_above_ema_200 === true) htf_trend = 'Up';
    else if (daily_price_above_ema_200 === false) htf_trend = 'Down';

    // 2. Determine Volatility
    const volatility = (atr_4h_norm > regimeVolatilityThreshold) ? 'High' : 'Low';

    // 3. Veto ALL signals if in Neutral/High-Vol chop
    if (htf_trend === 'Neutral' && volatility === 'High') {
      const reason = `Regime: Veto. Volatile CHOP.`;
      console.log(reason, `(${symbol})`);
      results.push({ json: { symbol, signal: 'flat', reason, regime: htf_trend } });
      continue;
    }

    // --- (v1.3) ADVANCED CONFLUENCE LOGIC ---
    const buySignals = arr.filter(s => s.signal === 'buy');
    const sellSignals = arr.filter(s => s.signal === 'sell');

    let filteredArr = [];
    let confluenceReason = "No Signal";

    // --- Find all signal types ---
    const tech_buys = buySignals.some(s => TECHNICAL_SCORERS.includes(s.signalType));
    const dynamic_buys = buySignals.some(s => DYNAMIC_SCORERS.includes(s.signalType));
    const reversion_buys = buySignals.some(s => s.signalType === 'reversion');

    const tech_sells = sellSignals.some(s => TECHNICAL_SCORERS.includes(s.signalType));
    const dynamic_sells = sellSignals.some(s => DYNAMIC_SCORERS.includes(s.signalType));
    const reversion_sells = sellSignals.some(s => s.signalType === 'reversion');


    if (htf_trend === 'Up') {
      // --- v1.3 LOGIC: Look for BUYS (with trend) OR REVERSION SELLS (counter-trend) ---
      if (tech_buys || dynamic_buys) {
        filteredArr = buySignals;
        let reasons = [];
        if (tech_buys) reasons.push("Technical");
        if (dynamic_buys) reasons.push("Dynamic");
        confluenceReason = `Signal: ${reasons.join(' + ')} BUYS (With Trend)`;
      } else if (reversion_sells) {
        filteredArr = sellSignals.filter(s => s.signalType === 'reversion'); // Only take reversion sells
        confluenceReason = `Signal: Reversion SELLS (Counter-Trend)`;
      } else {
        confluenceReason = `No Buy Signals or Reversion Sells Found`;
      }
    } else if (htf_trend === 'Down') {
      // --- v1.3 LOGIC: Look for SELLS (with trend) OR REVERSION BUYS (counter-trend) ---
      if (tech_sells || dynamic_sells) {
        filteredArr = sellSignals;
        let reasons = [];
        if (tech_sells) reasons.push("Technical");
        if (dynamic_sells) reasons.push("Dynamic");
        confluenceReason = `Signal: ${reasons.join(' + ')} SELLS (With Trend)`;
      } else if (reversion_buys) {
        filteredArr = buySignals.filter(s => s.signalType === 'reversion'); // Only take reversion buys
        confluenceReason = `Signal: Reversion BUYS (Counter-Trend)`;
      } else {
        confluenceReason = `No Sell Signals or Reversion Buys Found`;
      }
    } else { // htf_trend === 'Neutral' (and Volatility is Low)
      // --- v1.3 LOGIC: (Same as v1.2) Look for any Reversion or Dynamic signal ---
      if (reversion_buys || dynamic_buys) {
        filteredArr = buySignals;
        let reasons = [];
        if (reversion_buys) reasons.push("Reversion");
        if (dynamic_buys) reasons.push("Dynamic");
        confluenceReason = `Signal: ${reasons.join(' + ')} BUYS (Range)`;
      } else if (reversion_sells || dynamic_sells) {
        filteredArr = sellSignals;
        let reasons = [];
        if (reversion_sells) reasons.push("Reversion");
        if (dynamic_sells) reasons.push("Dynamic");
        confluenceReason = `Signal: ${reasons.join(' + ')} SELLS (Range)`;
      } else {
        confluenceReason = "Range. No Reversion or Dynamic signals.";
      }
    }

    // --- Check if any signals were found ---
    if (filteredArr.length === 0) {
      const reason = `Regime: ${htf_trend}. ${confluenceReason}.`;
      console.log(reason, `(${symbol})`);
      results.push({ json: { symbol, signal: 'flat', reason, regime: htf_trend } });
      continue;
    }
    // --- END CONFLUENCE LOGIC ---

    // --- If we get here, VALID SIGNALS WERE FOUND ---

    // --- Calculate a confidence-weighted average signal ---
    const avgConfidence = Math.min(1, filteredArr.reduce((a, b) => a + (b.confidence || 0), 0) / Math.max(1, filteredArr.length));

    // Find the "best" signal to provide price, SL, and strategy type
    filteredArr.sort((a, b) => b.confidence - a.confidence);
    const bestSignal = filteredArr[0];
    const strategyType = bestSignal.signalType;
    
    // --- v1.4: CALCULATE SL/TP PRICES ---
    const meta = bestSignal.meta || {};
    const signal = bestSignal.signal;
    const price = bestSignal.price;
    const slPips = bestSignal.recommendedSLPips || null;
    const tpPips = bestSignal.recommendedTPPips || null;

    // Robust PipSize Logic
    let pipSize = 0.01; // Default for JPY pairs or XAU
    if (meta && meta.pip_size) {
      pipSize = meta.pip_size;
    } else if (symbol && !symbol.includes('JPY') && !symbol.includes('XAU')) {
      pipSize = 0.0001; // Default for non-JPY majors/minors
    }

    let sl_price = null;
    let tp_price = null;

    if (signal === 'buy' && price && slPips) {
      sl_price = price - (slPips * pipSize);
    } else if (signal === 'sell' && price && slPips) {
      sl_price = price + (slPips * pipSize);
    }

    if (signal === 'buy' && price && tpPips) {
      tp_price = price + (tpPips * pipSize);
    } else if (signal === 'sell' && price && tpPips) {
      tp_price = price - (tpPips * pipSize);
    }
    // --- End v1.4 Calculation ---

    // --- Create the Raw Signal Object ---
    const rawSignal = {
      symbol: symbol,
      signal: signal, // 'buy' or 'sell'
      price: price,
      confidence: avgConfidence,
      strategyType: strategyType,
      reason: confluenceReason, // e.g., "Signal: Reversion BUYS (Counter-Trend)"
      regime: htf_trend,
      
      // --- v1.4: ADDED SL/TP pips AND price ---
      recommendedSLPips: slPips,
      recommendedTPPips: tpPips,
      sl_price: sl_price,
      tp_price: tp_price,
      // ---
      
      indicators: bestSignal.indicators,
      sr_data: bestSignal.sr_data,
      meta: meta
    };

    // Add this raw signal to the results to be passed to the next node
    results.push({ json: rawSignal });

  } catch (err) {
    console.error(`Error processing ${symbol}:`, err.message);
    results.push({ json: { symbol, signal: 'flat', reason: `VETO: Node error: ${err.message}` } });
    continue;
  }
}

// Return all confluent signals to the next node
return results;
