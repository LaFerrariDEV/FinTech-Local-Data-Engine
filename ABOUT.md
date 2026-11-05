# QuantAgent: what it is and what it does

**Live:** https://laferraridev.github.io/FinTech-Local-Data-Engine/

---

## Part 1: The simple version

Imagine you have a huge spreadsheet of a stock's prices: every minute, for two years. That's a
million rows. Excel would freeze. Most websites would make you upload it to their servers.

**QuantAgent is a website that handles all of that right inside your browser.** Nothing gets
uploaded. Your data never leaves your computer.

Here's what you can do with it:

1. **Drop in a file.** Drag a price file (CSV or Parquet) onto the page. It loads a million rows
   in about 4 seconds, and the page never freezes, because the heavy work happens "in the
   background" (a separate worker thread, like a kitchen behind a restaurant).
2. **See the chart.** It draws candlestick charts, the green and red bars traders use, and
   lets you add indicators like moving averages (the "average price over the last 20 days" line)
   or RSI (a score showing if a stock has gone up "too fast").
3. **Ask questions with SQL.** SQL is a language for asking a database questions, like "which
   stock had the best returns?" There's a built-in database engine (DuckDB) that answers in
   milliseconds.
4. **Test a trading idea.** Say your rule is "buy when the short-term average crosses above the
   long-term average." The backtester replays history and shows how that rule would have done,
   compared to just buying and holding. It counts fees, and it never "cheats" by peeking at
   future prices.
5. **Check if the data is broken.** Real data is messy: missing days, impossible prices,
   duplicates. It gives the file a quality score out of 100 and shows exactly what's wrong.
6. **Talk to an AI.** An AI assistant can look at your data, run the database queries, test
   strategies and change the chart for you. It's only allowed to *read* data, never delete it.

**In one line:** it's a mini trading research lab that runs entirely in your browser, fast and
private, with an AI helper built in.

---

## Part 2: The advanced version

A local-first quantitative research workbench: columnar analytics, technical indicators,
vectorized backtesting and LLM tool use, all executed client-side over DuckDB-WASM.

### Data engine
- **Execution:** DuckDB-WASM (v1.5.4) runs in a dedicated engine worker, which spawns DuckDB in a
  nested worker. The UI thread communicates via typed RPC; results cross the boundary as
  transferable `Float64Array` columns (zero-copy). The client has per-call timeouts, abort
  signals, heartbeat liveness checks and crash recovery.
- **Persistence:** optional OPFS-backed database (database file and WAL registered as
  FS-access handles), surviving reloads.
- **Ingestion:** strict CSV parsing (64 MB max line, quoted multi-line fields, full-file type
  inference on conversion errors) that never silently drops rows. Lenient mode routes malformed
  lines to a rejects table and reports line number, error type and raw line. Parquet is decoded
  in-worker (pure JS) and streamed into DuckDB as Arrow IPC batches.
- **Normalization:** heuristic OHLCV schema mapping, then projection onto a canonical
  `(symbol, ts, open, high, low, close, volume)` table. The mapper recognizes Yahoo, Binance
  klines and `PX_LAST`-style columns, long multi-symbol files, epoch s/ms/µs/ns, `YYYYMMDD`
  integers and formatted strings. Duplicate `(symbol, ts)` keys keep the last occurrence in file
  order, and duplicates, nulls and out-of-order rows are all counted and reported. The raw table
  is always retained.

### Resampling and indicators
- **Bar aggregation:** done in SQL with `time_bucket`. Open is the first trade price in the
  bucket (`arg_min(open, ts)`), close is the last (`arg_max(close, ts)`), high is the max, low
  is the min, and volume is the sum. Weekly buckets are Monday-aligned. "Auto" picks the finest
  timeframe whose span still fits a 20,000-bar render budget, at or above the native sampling
  interval.
- **Window indicators, computed in SQL** (all NaN until the window is full):
  - SMA
  - Bollinger bands (population σ)
  - rolling VWAP on typical price `(H+L+C)/3`
  - rolling σ of log returns
  - running drawdown `C / cummax(C) − 1`
- **Recursive indicators, computed as worker kernels in O(n):**
  - EMA, seeded with the SMA of the first *n* values, α = 2/(n+1)
  - Wilder RSI and ATR, using Wilder smoothing (α = 1/n) and true range with gap handling
  - MACD with its signal line and histogram
- **Validation:** indicators are cross-checked against reference implementations in the test
  suite, as is weekly OHLC aggregation against an independent JS aggregator.

### Backtester
- **Timing model (no look-ahead):** the target position *wₜ* is decided at the close of bar *t*
  and held over bar *t+1*. Bar return:
  `rₜ₊₁ = wₜ · (Cₜ₊₁/Cₜ − 1) − c · |wₜ − wₜ₋₁|`,
  where *c* = fee + slippage in bps, charged on turnover. Equity compounds multiplicatively.
- **Strategies:**
  - SMA or EMA crossover (long/flat or long/short)
  - RSI mean reversion with hysteresis
  - Bollinger breakout with exit at the mid band
  - MACD-signal trend
  - buy and hold
  - **custom SQL signals:** any read-only query over a `bars` CTE that returns `(ts, position)`
    is as-of joined onto the bar grid, clipped to [−1, 1], or [0, 1] when shorting is
    disabled. A custom-SQL SMA crossover is verified to reproduce the built-in one exactly.
- **Metrics:**
  - total return and CAGR
  - annualized volatility and Sharpe (rf = 0), annualized with the *empirical* bars-per-year
    of the dataset, so trading-day and 24/7 data are both handled correctly
  - Sortino (downside deviation)
  - max drawdown and its duration
  - Calmar
  - trade count, win rate, average win and loss, profit factor
  - exposure and turnover
- **Reports:** a buy-and-hold benchmark under the same cost model, a monthly return heatmap, a
  bar-return distribution clipped at the 0.5–99.5 percentiles, and a trade blotter. Equity
  curves are LTTB-downsampled for display only; metrics use every bar.

### Data quality audit
- OHLC consistency violations (H < L, or O/C outside [L, H])
- non-positive prices and negative volume
- duplicate timestamps and out-of-order source rows
- gaps larger than 5× the median Δt
- log-return outliers beyond 8σ (bad ticks, unadjusted splits)
- stale-price runs of 10 or more bars with an unchanged close
- quarantined CSV rows

All of this is scored 0–100, weighted by severity and prevalence.

### Agent
A provider-neutral tool-calling loop: Claude through the official Anthropic SDK, or any
OpenAI-compatible endpoint (OpenAI, BazaarLink, OpenRouter, Ollama, LM Studio). Its tools:
- `list_datasets` and `describe_table`
- `run_sql`: single-statement and read-only, guarded against writes, `ATTACH`, `COPY` and file
  reads
- `compute_indicators`
- `run_backtest`
- `data_quality`
- `show_chart`, which drives the UI

History is append-only and stays well-formed when a run is cancelled. API keys stay in the
user's browser.

### Known limitations
- Single-asset backtests: no portfolio construction, position sizing or leverage.
- Fills are close-to-close at the signal bar's close; there's no intrabar execution, spread
  model or market impact beyond flat bps costs.
- No corporate-action adjustment beyond what the source data already contains, and no
  survivorship-bias handling.
- Bounded by 32-bit WebAssembly memory: practical datasets are roughly 1–2 GB of raw data.

### Validation
- **126 automated tests:**
  - 108 unit and integration tests against real DuckDB-WASM
  - 18 end-to-end browser tests on the production build
- Coverage includes a 1M-row ingest with exact row and sum checks, memory-leak and UI-freeze
  probes, crash recovery, OPFS persistence, and agent tool loops.
- Both suites run on every pull request in GitHub Actions.
