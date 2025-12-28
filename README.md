---

# Quantitative Forex Pipeline (Stateless Architecture)

This system is a robust MVP (Minimum Viable Product) for an automated quant desk. It excels at Logic Segregation and Multi-Strategy Confluence. However, to move this to a production hedge-fund level, the next steps would be:

Migrating to a Tick-Data Provider (like OANDA or Websockets) to handle real-time spreads.

Implementing a State-Database (Redis) to track open positions and prevent 'Signal Hammering'.

Vectorized Backtesting in Python to verify that the '0.7 ATR Veto' actually improves the Sharpe Ratio over a 5-year sample.

## I. System Overview: The Stateless Pipeline

This architecture separates market analysis (**n8n**) from order execution (**Python/MT5**). It is built on a **stateless architecture**, meaning it treats every poll as an independent mathematical problem. This ensures no "logic drift" occurs from previous market states, providing a clean slate for every decision.

### The Workflow at a Glance:

* **Ingestion:** Telegram or Cron triggers the data pull.
* **Normalization:** Raw candles are transformed into Multi-Timeframe (MTF) objects.
* **Mapping:** Daily price extremes are established as institutional markers.
* **Specialization:** Parallel "Scorers" (Strategy Experts) analyze different alpha sources.
* **Adjudication:** A Confluence Engine applies a Regime Filter and Volatility Veto.
* **Dispatch:** A finalized JSON packet is sent for execution.

---

## II. Node-by-Node Functional Breakdown

### 1. Data Ingestion (Trigger & HTTP Get)

* **What it does:** Fetches OHLC (Open, High, Low, Close) data for 5m, 15m, 1h, 4h, and 1D intervals via the **Twelve Data API**.
* **The "Why":** Without MTF data, a bot is "blind." You cannot judge a 15-minute entry without knowing if the 4-hour trend is behind you.
* **Parameters:** Uses an `outputsize` of 200+ to ensure enough data for long-period indicators like the **200 EMA**.

### 2. MTF Combiner (The Transformer)

* **What it does:** Reverses API data (Newest-to-Oldest  Oldest-to-Newest), calculates **Typical Price** , and computes a 90-period Historical ATR.
* **The "Why":** Indicators like RSI and EMA are iterative; if you don't calculate them chronologically (past to present), the values are mathematically garbage.
* **Logic:** It ensures a `pip_size` fallback (0.01 for JPY/Gold, 0.0001 for others) to prevent SL/TP calculation failures.

### 3. S/R Filter (The Cartographer)

* **What it does:** Identifies **Previous Day High (PDH)**, **Low (PDL)**, and daily **Pivot Points**.
* **The "Why":** Markets have "memory." These levels act as psychological magnets where liquidity (stop losses) is concentrated.

### 4. The Expert Scorers (Parallel Alpha Generation)

We use a **Multi-Strategy Ensemble** approach. Each node looks for a different market phenomenon:

* **Scorer_Structure:** Uses Break-of-Structure (BOS) and Change-of-Character (CHOCH) to track trend health.
* **Scorer_Liquidity:** Identifies **Fair Value Gaps (FVG)**—imbalances where price moved too fast and needs to "re-fill."
* **Scorer_Mean_Reversion:** Uses **Bollinger Bands** & **StochRSI** to find "exhausted" price action outside of  deviations.
* **Scorer_Trend:** A classic momentum model looking for shallow pullbacks to the **15m 21-EMA**.
* **Scorer_VWAP:** (Blueprint) Measures Institutional Fair Value. *Note: Currently inactive due to API volume limitations.*

### 5. Confluence Engine (The Judge)

* **What it does:** Applies the **Regime Filter** (Daily 200 EMA) and the **Volatility Veto** (ATR Norm > 0.7).
* **The "Why":** This is the risk management layer. It prevents "Counter-Trend" suicide and stops the bot from trading during "News Spikes" where spreads widen and technicals fail.
* **Logic:** If Regime is "Up," it prioritizes trend-following buys but allows "Reversion" sells as hedges.

---

## III. Market Concepts & Theoretical Underpinnings

| Concept | Application | The "Quantitative Why" |
| --- | --- | --- |
| **Institutional Liquidity** | PDH/PDL & FVGs | Markets move from one liquidity pool to the next. We enter where "Big Money" is likely to re-enter. |
| **Volatility Normalization** | ATR Percentile (0.7) | A 50-pip move is "quiet" for Gold but "extreme" for EUR/GBP. ATR allows the bot to adapt to the asset's "personality." |
| **Mean Reversion** | StochRSI + BB | Based on the **Law of Large Numbers**. Probability of return to mean increases as price reaches statistical extremes. |
| **Session Seasonality** | London/NY Filter | 80% of volume occurs in specific windows. Trading outside these hours leads to "death by a thousand cuts" (spread/swap costs). |

---

## IV. Critical Analysis & System Limitations

As a professional architecture, this system requires a "failure map" to identify areas for future optimization.

1. **Volume Blindness (The VWAP Problem):** The Twelve Data basic tier doesn't provide volume for FX. The VWAP scorer is currently a "zombie node." Without volume, we cannot distinguish between "Big Money" moves and "Retail Noise."
2. **Spread & Slippage Ignorance:** The system currently assumes a "Zero Spread" environment. In live execution, a 2-pip spread on a 15-pip target is a 13% immediate tax.
3. **Latency in a Stateless Pipeline:** n8n is an orchestrator, not a low-latency engine. Processing can take 5–10 seconds. In high-volatility "Breakout" scenarios, the "meat of the move" may be missed.
4. **Lack of Portfolio Correlation:** The bot analyzes symbols in isolation. If it sees a "Buy" on EUR/USD, GBP/USD, and AUD/USD, it may take all three, effectively triple-leveraging on USD weakness without realizing the correlated risk.

---

## V. Final Output

The system concludes by sending a clean JSON packet to **Telegram**. This packet contains:

* **Signal:** (Buy/Sell/Flat)
* **Confidence Score:** (0-1)
* **Entry/SL/TP:** Mathematically derived prices.
* **Reasoning:** A string explaining why the Confluence Engine made its decision.
