This system is designed as a stateless, multi-stage pipeline. Each node has a specific role, processing the data and passing it to the next stage. Here is a detailed breakdown of each node in the execution order.



#### 1. `Telegram Trigger` (Trigger Node)
* **Purpose:** To manually initiate the workflow on-demand.
* **Reasoning & Parameters:** This workflow is triggered by a Telegram message (e.g., sending `/trade EUR/USD`). This was chosen over a `Cron` (time-based) node because it provides flexibility for on-demand analysis and allows the user to *dynamically* pass in the `symbol` (e.g., `EUR/USD`, `XAU/USD`) to be analyzed.

#### 2. `HTTP Get` (x5) & `Quote` (x1) (Data Fetching Nodes)
* **Purpose:** To fetch all raw market data from the **Twelve Data API**.
* **Reasoning & Parameters:**
    * **MTF Data:** The system is "Multi-Timeframe" (MTF), so it requires data from multiple intervals simultaneously. We fetch 5m, 15m, 1h, 4h, and 1D data.
        * **`interval`:** Set to `5min`, `15min`, `1h`, `4h`, and `1day`.
        * **`outputsize`:** Set to 200+. This is crucial to ensure we have enough data to calculate long-period indicators like the `200 EMA`.
    * **`Quote` Node:** The `time_series` endpoint provides historical candles. The `Quote` node was intended to fetch the *real-time* `bid`/`ask` price for precise execution.
* **Limitations (Critical):**
    * **No Volume Data:** A major discovery during development was that the free/basic tier of the Twelve Data API **does not provide `volume` data** for Forex (FX) pairs. This is a common issue with decentralized FX markets. This directly impacts the `Scorer_VWAP` node, which is now non-functional as it *requires* volume for its calculation.
    * **No Bid/Ask Price:** The `Quote` endpoint also did not provide real-time `bid`/`ask` prices, only a last-known price. This means the system cannot natively calculate the *spread*. All SL/TP calculations are based on the candle's `close` or `price`, and a spread must be (and is not yet) added manually.

#### 3. `Merge1` (Merge Node)
* **Purpose:** To bundle the five parallel candle data streams.
* **Reasoning & Parameters:**
    * **Mode: `Append`:** This node waits for all 5 `HTTP Get` requests (5m to 1D) to complete. It then appends their outputs into a single batch (an array of 5 items) to pass to the next node. This is essential so the `MTF_Combiner` receives all its required data in one go.

#### 4. `MTF` (Custom JavaScript: `MTF_Combiner.js`)
* **Purpose:** The central data-processing and feature-engineering hub.
* **Reasoning & Parameters:** This node receives the 5 sets of candle data and performs several critical tasks:
    1.  **Combine:** It structures the data into a single, clean JSON object (e.g., `data_5m: [...]`, `data_1h: [...]`).
    2.  **Feature Engineering (Typical Price):** It iterates over *every single candle* on all timeframes to calculate and add the `typical` price (HLC/3). This was added specifically for the `Scorer_VWAP` node (which is now defunct due to the lack of volume).
    3.  **Feature Engineering (Historical ATR):** It calculates a 90-period history of the 4-hour ATR. This array is passed to all scorers so they can normalize the *current* 4H ATR (see `atr_4h_norm`) and gauge market volatility.
    4.  **Pip Size Fallback:** It ensures a `pip_size` is always present, defaulting to `0.01` for `XAU`/`JPY` and `0.0001` for others, which fixed critical bugs in our SL/TP calculations.

#### 5. `S/R Filter` (Custom JavaScript Node)
* **Purpose:** To calculate daily Support/Resistance levels.
* **Reasoning & Parameters:** Several strategies (`Scorer_Structure`, `Scorer_Trend`) rely on key daily price levels. This node takes the `data_daily` from the `MTF` node and calculates:
    * Previous Day's High, Low, and Close (`PDH`, `PDL`, `PDC`).
    * Standard Pivot Points (`P`, `R1-R3`, `S1-S3`).
    This centralizes the calculation, so it's not repeated in every scorer node.

#### 6. `AI_Merge` (Merge Node)
* **Purpose:** To combine the main *candle data* with the *S/R data*.
* **Reasoning & Parameters:**
    * **Mode: `Append`:** The scorers need *both* the MTF candle data and the S/R levels. This node waits for `MTF` and `S/R Filter` to finish, then bundles their outputs into one package (an array of 2 items) for all scorers to use.

#### 7. The "Scorer" Nodes (x6) (Parallel JavaScript Nodes)
* **Purpose:** These are the "alpha" models. They run in parallel, each executing a different trading strategy on the same data.
* **Reasoning:** A multi-strategy approach is more robust. Each scorer is a custom JavaScript node that outputs a signal object (`buy`, `sell`, or `flat`) with a `confidence` score, `strategyType`, and `recommendedSLPips`/`TPPips`.
* **`Scorer_Structure` (`market_structure`):** A Break-of-Structure (BOS) / Change-of-Character (CHOCH) model. It looks for a 1H candle close *above* the `PDH` or *below* the `PDL`, using 1H RSI for momentum confirmation.
* **`Scorer_Liquidity` (`liquidity`):** A "Smart Money Concept" (SMC) model. It identifies 1-Hour Fair Value Gaps (FVGs) and triggers a signal when the price pulls back *into* that FVG in alignment with the daily trend.
* **`Scorer_Mean` (`reversion`):** A mean-reversion strategy. It triggers when the 15-minute price is *outside* the Bollinger Bands **and** the 15m StochRSI is in an extreme zone (<20 for buy, >80 for sell).
* **`Scorer_Trend` (`momentum`/`shallow_pullback`):** A classic trend-following model. In a confirmed uptrend, it looks for the price to pull back to the 15-minute 21-EMA.
* **`Scorer_VWAP` (`vwap_bias`):** **(NON-FUNCTIONAL)** This node is VETO'd on every run. Its logic (Price > 1H VWAP, pullback to 15m VWAP) is sound, but its `calculateVWAP` function fails because the `volume` data (as mentioned in point 2) is missing from the API.
* **`Scorer_Breakout` (`breakout`):** This is a **placeholder** node. It was intended to house a volatility breakout strategy (e.g., Donchian Channel), but the logic has not been implemented. It currently returns `flat` on every run.

#### 8. `Result Merge` (Merge Node)
* **Purpose:** To gather all six (or five, in our case) signal outputs from the parallel scorers.
* **Reasoning & Parameters:**
    * **Mode: `Append`:** This node waits for all scorers to finish, then bundles their 6 signal objects (e.g., `[{signal: 'buy'}, {signal: 'flat'}, ...]`) into a single list for the final "brain."

#### 9. `Confluence` (Custom JavaScript: `Confluence_Stateless.js`)
* **Purpose:** This is the "brain" or "final decision-maker" of the entire system.
* **Reasoning & Parameters:** This node receives the list of all signals and applies the master strategy filter.
    1.  **Regime Filter:** It first reads the `daily_price_above_ema_200` to set the High-Timeframe "Regime" to "Up," "Down," or "Neutral."
    2.  **Volatility Veto:** It checks the `atr_4h_norm`. If the regime is "Neutral" and volatility is "High" (threshold set at `0.7`), it VETOs all trades to avoid unpredictable "chop."
    3.  **Confluence Logic (v1.3):** This is the core logic. Instead of a simple `AND` (too strict) or `OR` (too loose), it uses an intelligent filter:
        * **If Regime="Up":** It approves any `buy` signal from Technical or Dynamic scorers. It will *also* approve a `sell` signal, but *only* if it's from a `reversion` scorer (allowing a counter-trend fade).
        * **If Regime="Down":** It does the opposite, approving all `sell` signals and only `reversion` `buy` signals.
    4.  **Final Output (v1.4):** It selects the "best" signal (highest confidence), calculates the final `sl_price` and `tp_price` (which was a key addition), and bundles everything into one clean JSON signal. If no signal passes, it *always* outputs a `flat` signal with a detailed `reason` (e.g., "Regime: Down. No Sell Signals or Reversion Buys Found.").

#### 10. `Send a text message` (Telegram Node)
* **Purpose:** To deliver the final, clean JSON signal.
* **Reasoning & Parameters:** This node completes the loop. It sends the final JSON output from the `Confluence` node back to the user's Telegram chat. This JSON is formatted to be read by an external system (like a Python bot) for automated execution.
