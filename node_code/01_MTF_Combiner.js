// NODE: MTF_Combiner (v3.1 - System Ready)
// DESC: This node now requires 5 inputs and provides all data for downstream scorers.
// 1. 5m candles
// 2. 15m candles
// 3. 1h candles
// 4. 4h candles
// 5. 1D candles
// It also calculates 'hist_atr_4h' and bundles all data into a single object.
//
// --- v3.1 ---
// + Added 'addTypicalPrice' helper to automatically add (HLC/3) to all candles.
// + Added robust 'pipSize' fallback logic to the base meta object.

if (items.length < 5) {
  throw new Error("MTF Combiner (v3.1) expects 5 inputs (5m, 15m, 1h, 4h, 1D).");
}

// Helper to safely get data
const getData = (item, tf) => {
  if (!item || !item.json || !item.json.values || !item.json.meta) {
    console.warn(`Input for ${tf} is missing or has invalid format.`);
    return { values: [], meta: { interval: tf } };
  }
  return item.json;
};

// --- Helper function to calculate ATR (needed for hist_atr_4h) ---
function calculateATR(data, period = 14) {
    if (!data || data.length < period + 1) return { atr: null, values: [] };
    
    // Data is newest first (descending), reverse to be chronological (ascending)
    const candles = [...data].reverse(); 
    let trValues = [];
    
    // Check for bad data in first candle
    if (isNaN(parseFloat(candles[0].high)) || isNaN(parseFloat(candles[0].low))) {
        return { atr: null, values: [] };
    }
    trValues.push(parseFloat(candles[0].high) - parseFloat(candles[0].low));

    for (let i = 1; i < candles.length; i++) {
        let h = parseFloat(candles[i].high);
        let l = parseFloat(candles[i].low);
        let prevClose = parseFloat(candles[i-1].close);
        
        // Skip if any candle data is invalid
        if (isNaN(h) || isNaN(l) || isNaN(prevClose)) continue; 
        
        let tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
        trValues.push(tr);
    }
    
    if(trValues.length < period) return { atr: null, values: [] };
    
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
    
    // Return all values, in chronological order (oldest to newest)
    return { atr: atrValues[atrValues.length - 1], values: atrValues };
}
// --- End ATR Helper ---

// --- v3.1 NEW HELPER ---
/**
 * Iterates over a candle array and adds the 'typical' price (HLC/3).
 * @param {Array} candles - Array of candle objects.
 * @returns {Array} - New array with 'typical' price added.
 */
function addTypicalPrice(candles) {
    if (!candles || candles.length === 0) return [];
    return candles.map(c => {
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const close = parseFloat(c.close);
        
        // If data is bad, return original candle
        if (isNaN(high) || isNaN(low) || isNaN(close)) {
            return c;
        }
        
        const typical = (high + low + close) / 3;
        // Return a new object with all original properties + typical
        return { ...c, typical: typical };
    });
}
// --- End v3.1 Helper ---

// Assign inputs based on expected order
const data_5m  = getData(items[0], '5m');
const data_15m = getData(items[1], '15m');
const data_1h  = getData(items[2], '1h');
const data_4h  = getData(items[3], '4h');
const data_1d  = getData(items[4], '1D'); // <-- (Item 12) NEW 5th INPUT

// --- (Item 12) Calculate historical ATR for 4H ---
// This is REQUIRED by all scorers for atr_4h_norm
const atr4h_data = calculateATR(data_4h.values || [], 14);

// Get the last 90 ATR values (or as many as we have)
// The `values` array is chronological (oldest to newest)
const hist_atr_4h = atr4h_data.values.slice(-90); 
// --- End new calculation ---

// Use the 15m data as the "base" for the symbol and primary meta
const symbol = data_15m.meta.symbol || data_1h.meta.symbol || 'UNKNOWN';

// This meta object MUST contain the pip_size.
const baseMeta = data_15m.meta;

// --- v3.1 FIX: Add robust pipSize fallback ---
if (baseMeta && !baseMeta.pip_size) {
    baseMeta.pip_size = symbol.includes('JPY') ? 0.01 : 0.0001;
    console.warn(`MTF_Combiner: pip_size was missing, defaulted to ${baseMeta.pip_size}`);
}
// ---

const combinedData = {
  symbol: symbol,
  primary_tf: '15m', // We'll base our LTF signal on the 15m
  trend_tf: '4h',    // We'll base our HTF bias on the 4h
  
  // --- All required candle data ---
  // --- v3.1: Apply 'addTypicalPrice' to all candle arrays ---
  data_5m: addTypicalPrice(data_5m.values || []),
  data_15m: addTypicalPrice(data_15m.values || []),
  data_1h: addTypicalPrice(data_1h.values || []),
  data_4h: addTypicalPrice(data_4h.values || []),
  data_daily: addTypicalPrice(data_1d.values || []), // <-- (Item 12) RENAMED to 'data_daily'

  // --- (Item 12) NEW Required data ---
  hist_atr_4h: hist_atr_4h,
  
  // Pass along meta from the primary (LTF) timeframe
  meta: baseMeta 
};

// Return a *single item* containing all data
return [{ json: combinedData }];
