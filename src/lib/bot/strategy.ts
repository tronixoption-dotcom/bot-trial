/**
 * Pure strategy + safety rules. No I/O. Everything the bot decides goes through here.
 *
 * Scoring methodology (documented, same 0–100 scale for both scores):
 *   Over the last N tick-to-tick moves of the sample:
 *     Bullish score = (up-moves   / N) * 100
 *     Bearish score = (down-moves / N) * 100
 *   Difference = |Bullish - Bearish|. A market qualifies only if Difference >= 5.
 *   Bullish advantage -> evaluate OVER 2. Bearish advantage -> evaluate UNDER 7.
 */

// ---- LOCKED CONTRACT PARAMETERS (never configurable) ----
export const CONTRACT_DURATION = 1 as const;
export const DURATION_UNIT = "t" as const;
export const MIN_DIFFERENCE = 5;

export type Direction = "OVER2" | "UNDER7";

export const CONTRACTS = {
  OVER2: { contract_type: "DIGITOVER", barrier: "2", entryDigits: [0, 1], label: "OVER 2" },
  UNDER7: { contract_type: "DIGITUNDER", barrier: "7", entryDigits: [8, 9], label: "UNDER 7" },
} as const;

export function lastDigit(quote: number, pipSize: number): number {
  const s = quote.toFixed(pipSize);
  return Number(s.charAt(s.length - 1));
}

export function pipSizeFromPip(pip: number): number {
  return Math.max(0, Math.round(-Math.log10(pip)));
}

export interface Analysis {
  sufficient: boolean;
  moves: number;
  bullish: number;
  bearish: number;
  difference: number;
  trend: "BULLISH" | "BEARISH" | "FLAT";
  qualifies: boolean;
  direction: Direction | null;
}

export function analyze(
  quotes: number[],
  sampleSize: number,
  minSample: number,
  minDifference = MIN_DIFFERENCE,
): Analysis {
  const sample = quotes.slice(-(sampleSize + 1));
  const moves = sample.length - 1;
  if (moves < minSample || moves < 1) {
    return {
      sufficient: false,
      moves: Math.max(0, moves),
      bullish: 0,
      bearish: 0,
      difference: 0,
      trend: "FLAT",
      qualifies: false,
      direction: null,
    };
  }
  let up = 0,
    down = 0;
  for (let i = 1; i < sample.length; i++) {
    if (sample[i] > sample[i - 1]) up++;
    else if (sample[i] < sample[i - 1]) down++;
  }
  const bullish = round2((up / moves) * 100);
  const bearish = round2((down / moves) * 100);
  const difference = round2(Math.abs(bullish - bearish));
  const trend = bullish > bearish ? "BULLISH" : bearish > bullish ? "BEARISH" : "FLAT";
  const qualifies = trend !== "FLAT" && difference >= minDifference;
  return {
    sufficient: true,
    moves,
    bullish,
    bearish,
    difference,
    trend,
    qualifies,
    direction: qualifies ? (trend === "BULLISH" ? "OVER2" : "UNDER7") : null,
  };
}

export function digitDistribution(digits: number[]) {
  const counts = Array(10).fill(0) as number[];
  digits.forEach((d) => counts[d]++);
  const n = digits.length;
  return {
    n,
    counts,
    pOver2: n ? digits.filter((d) => d > 2).length / n : 0,
    pUnder7: n ? digits.filter((d) => d < 7).length / n : 0,
  };
}

/** EV of one contract: p * (payout - stake) - (1 - p) * stake */
export function expectedValue(pWin: number, stake: number, payout: number): number {
  return pWin * (payout - stake) - (1 - pWin) * stake;
}

export function entryDigitOk(direction: Direction, digit: number): boolean {
  return (CONTRACTS[direction].entryDigits as readonly number[]).includes(digit);
}

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface EntryContext {
  connected: boolean;
  authorized: boolean;
  latencyMs: number | null;
  maxLatencyMs: number;
  tickAgeMs: number | null;
  maxTickAgeMs: number;
  symbolSupported: boolean;
  analysis: Analysis;
  confirmAnalysis: Analysis; // second, independent computation on a shifted window
  latestDigit: number | null;
  stake: number;
  fixedStake: number;
  doubleAfterLoss?: boolean;
  balance: number | null;
  busy: boolean;
  riskBlock: string | null;
  cooldownRemainingMs: number;
  realAccountBlocked: boolean;
  minDifference?: number;
  checkEntryDigit?: boolean;
  requireConfirmation?: boolean;
  /** A conservative, data-backed block produced by the learning layer. */
  learningBlock?: string | null;
}

export interface LearningPattern {
  trades: number;
  wins: number;
  losses: number;
  profit: number;
}

/**
 * Learns only by refusing repeatedly poor patterns. It never increases stake or
 * relaxes a safety rule. The lower confidence bound avoids reacting to a few
 * random losses (95% normal approximation, minimum 30 observations).
 */
export function learningBlock(pattern: LearningPattern | undefined, minTrades = 30): string | null {
  if (!pattern || pattern.trades < minTrades) return null;
  const p = (pattern.wins + 1) / (pattern.trades + 2); // Laplace smoothing
  const se = Math.sqrt((p * (1 - p)) / (pattern.trades + 2));
  const lower95 = p - 1.96 * se;
  if (lower95 < 0.5)
    return `Learned guard: pattern win-rate lower bound ${(lower95 * 100).toFixed(1)}% after ${pattern.trades} trades`;
  return null;
}

export function evaluateEntry(c: EntryContext): { checks: Check[]; direction: Direction | null } {
  const a = c.analysis;
  const dir = a.direction;
  const checks: Check[] = [
    {
      id: "conn",
      label: "API connection active",
      pass: c.connected,
      detail: c.connected ? "Connected" : "Disconnected",
    },
    {
      id: "auth",
      label: "Account authorized",
      pass: c.authorized,
      detail: c.authorized ? "Authorized" : "Not authorized",
    },
    {
      id: "latency",
      label: "API latency acceptable",
      pass: c.latencyMs !== null && c.latencyMs <= c.maxLatencyMs,
      detail: c.latencyMs === null ? "Unknown" : `${c.latencyMs} ms`,
    },
    {
      id: "fresh",
      label: "Market data fresh",
      pass: c.tickAgeMs !== null && c.tickAgeMs <= c.maxTickAgeMs,
      detail: c.tickAgeMs === null ? "No tick" : `${(c.tickAgeMs / 1000).toFixed(1)} s old`,
    },
    {
      id: "symbol",
      label: "Market supported",
      pass: c.symbolSupported,
      detail: c.symbolSupported ? "Yes" : "Not offered by API",
    },
    {
      id: "sample",
      label: "Minimum statistical sample",
      pass: a.sufficient,
      detail: `${a.moves} moves`,
    },
    {
      id: "diff",
      label: `Bull/bear difference ≥ ${c.minDifference ?? MIN_DIFFERENCE}`,
      pass:
        a.sufficient && a.difference >= (c.minDifference ?? MIN_DIFFERENCE) && a.trend !== "FLAT",
      detail: `${a.difference}`,
    },
    {
      id: "confirm",
      label: "Double-confirmed direction",
      pass: c.requireConfirmation === false || (!!dir && c.confirmAnalysis.direction === dir),
      detail:
        c.requireConfirmation === false
          ? "Disabled by user"
          : (c.confirmAnalysis.direction ?? "No confirmation"),
    },
    {
      id: "digit",
      label: "Entry digit matches direction",
      pass:
        c.checkEntryDigit === false ||
        (!!dir && c.latestDigit !== null && entryDigitOk(dir, c.latestDigit)),
      detail:
        c.checkEntryDigit === false
          ? "Not used for this strategy"
          : digitDetail(dir, c.latestDigit),
    },
    {
      id: "stake",
      label: "Stake matches selected entry stake",
      pass:
        c.stake > 0 &&
        (c.stake === c.fixedStake || (c.doubleAfterLoss === true && c.stake === c.fixedStake * 2)),
      detail: `${c.stake}`,
    },
    {
      id: "funds",
      label: "Balance covers stake",
      pass: c.balance !== null && c.balance >= c.stake,
      detail: c.balance === null ? "Unknown" : `${c.balance}`,
    },
    {
      id: "busy",
      label: "No other active trade",
      pass: !c.busy,
      detail: c.busy ? "Trade in progress" : "Free",
    },
    {
      id: "cooldown",
      label: "Cooldown elapsed",
      pass: c.cooldownRemainingMs <= 0,
      detail:
        c.cooldownRemainingMs > 0 ? `${Math.ceil(c.cooldownRemainingMs / 1000)} s left` : "Ready",
    },
    {
      id: "risk",
      label: "No risk limit triggered",
      pass: !c.riskBlock,
      detail: c.riskBlock ?? "OK",
    },
    {
      id: "real",
      label: "Account mode permitted",
      pass: !c.realAccountBlocked,
      detail: c.realAccountBlocked ? "Real trading not enabled" : "OK",
    },
    {
      id: "learning",
      label: "Learned pattern remains acceptable",
      pass: !c.learningBlock,
      detail: c.learningBlock ?? "No learned block",
    },
  ];
  const all = checks.every((k) => k.pass);
  return { checks, direction: all ? dir : null };
}

function digitDetail(dir: Direction | null, d: number | null) {
  if (d === null) return "No digit";
  if (!dir) return `Digit ${d} (no direction)`;
  return `Digit ${d} — needs ${CONTRACTS[dir].entryDigits.join(" or ")}`;
}

export function rejectionMessage(checks: Check[], dir: Direction | null): string {
  const f = checks.find((k) => !k.pass);
  if (!f) return "";
  const name = dir ? CONTRACTS[dir].label : "TRADE";
  if (f.id === "digit")
    return `${name} REJECTED — Latest digit is ${f.detail.match(/\d/)?.[0] ?? "?"}.`;
  if (f.id === "diff") return `${name} REJECTED — Bullish/bearish difference is ${f.detail}.`;
  if (f.id === "fresh") return "TRADE BLOCKED — Market data is stale.";
  return `${name} ${["conn", "auth", "latency", "risk", "real", "funds", "learning"].includes(f.id) ? "BLOCKED" : "REJECTED"} — ${f.label}: ${f.detail}.`;
}

// ---- Proposal validation (fail-closed) ----
export interface ProposalLike {
  echo_req?: Record<string, unknown>;
  proposal?: {
    id?: string;
    ask_price?: number;
    payout?: number;
    date_start?: number;
    spot_time?: number;
    longcode?: string;
  };
  error?: { message: string };
}

export function validateProposal(
  res: ProposalLike,
  expected: { direction: Direction; symbol: string; stake: number },
  receivedAtMs: number,
  nowMs: number,
  maxAgeMs = 2000,
): Check[] {
  const e = res.echo_req ?? {};
  const p = res.proposal;
  const ct = CONTRACTS[expected.direction];
  return [
    {
      id: "p_ok",
      label: "Proposal returned without error",
      pass: !res.error && !!p?.id,
      detail: res.error?.message ?? "OK",
    },
    {
      id: "p_duration",
      label: "Duration is exactly 1",
      pass: Number(e.duration) === CONTRACT_DURATION && e.duration !== undefined,
      detail: String(e.duration),
    },
    {
      id: "p_unit",
      label: "Duration unit is ticks",
      pass: e.duration_unit === DURATION_UNIT,
      detail: String(e.duration_unit),
    },
    {
      id: "p_type",
      label: "Contract type correct",
      pass: e.contract_type === ct.contract_type,
      detail: String(e.contract_type),
    },
    {
      id: "p_barrier",
      label: "Barrier correct",
      pass: String(e.barrier) === ct.barrier,
      detail: String(e.barrier),
    },
    {
      id: "p_symbol",
      label: "Symbol correct",
      pass: (e.underlying_symbol ?? e.symbol) === expected.symbol,
      detail: String(e.underlying_symbol ?? e.symbol),
    },
    {
      id: "p_stake",
      label: "Stake matches fixed stake",
      pass:
        Number(e.amount) === expected.stake &&
        e.basis === "stake" &&
        Number(p?.ask_price) === expected.stake,
      detail: `${e.amount} / ask ${p?.ask_price}`,
    },
    {
      id: "p_payout",
      label: "Payout above stake",
      pass: typeof p?.payout === "number" && p.payout > expected.stake,
      detail: String(p?.payout),
    },
    {
      id: "p_longcode",
      label: "Contract text says 1 tick",
      pass: !p?.longcode || /after 1 ticks?\b/i.test(p.longcode),
      detail: p?.longcode ? "1 tick" : "n/a",
    },
    {
      id: "p_fresh",
      label: "Proposal not expired",
      pass: nowMs - receivedAtMs <= maxAgeMs,
      detail: `${nowMs - receivedAtMs} ms`,
    },
  ];
}

export function buildProposalRequest(
  direction: Direction,
  symbol: string,
  stake: number,
  currency: string,
) {
  const ct = CONTRACTS[direction];
  return {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: ct.contract_type,
    barrier: ct.barrier,
    currency,
    duration: CONTRACT_DURATION,
    duration_unit: DURATION_UNIT,
    underlying_symbol: symbol,
  } as const;
}

export interface AccumulatorProposalLike {
  echo_req?: Record<string, unknown>;
  proposal?: { id?: string; ask_price?: number };
  error?: { message: string };
}

export function buildAccumulatorProposalRequest(
  symbol: string,
  stake: number,
  currency: string,
  growthRate: number,
) {
  return {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: "ACCU",
    currency,
    growth_rate: growthRate,
    underlying_symbol: symbol,
  } as const;
}

export function validateAccumulatorProposal(
  res: AccumulatorProposalLike,
  expected: { symbol: string; stake: number; growthRate: number },
): Check[] {
  const e = res.echo_req ?? {};
  const p = res.proposal;
  return [
    {
      id: "a_ok",
      label: "Accumulator proposal returned without error",
      pass: !res.error && !!p?.id,
      detail: res.error?.message ?? "OK",
    },
    {
      id: "a_type",
      label: "Accumulator contract type correct",
      pass: String(e.contract_type).toUpperCase() === "ACCU",
      detail: String(e.contract_type),
    },
    {
      id: "a_symbol",
      label: "Accumulator symbol correct",
      pass: (e.underlying_symbol ?? e.symbol) === expected.symbol,
      detail: String(e.underlying_symbol ?? e.symbol),
    },
    {
      id: "a_stake",
      label: "Accumulator stake matches fixed stake",
      pass:
        Number(e.amount) === expected.stake &&
        e.basis === "stake" &&
        Number(p?.ask_price) === expected.stake,
      detail: `${e.amount} / ask ${p?.ask_price}`,
    },
    {
      id: "a_growth",
      label: "Growth rate matches selected rate",
      pass: Number(e.growth_rate) === expected.growthRate,
      detail: String(e.growth_rate),
    },
  ];
}

// ---- Risk & cycles ----
export interface RiskConfig {
  maxDailyLoss: number;
  maxDrawdown: number;
  maxConsecLosses: number;
}
export interface RiskState {
  dailyPnl: number;
  peakEquity: number;
  equity: number;
  consecLosses: number;
}

export function riskBlock(s: RiskState, c: RiskConfig): string | null {
  if (s.dailyPnl <= -c.maxDailyLoss) return `Max daily loss reached (${s.dailyPnl.toFixed(2)})`;
  if (s.peakEquity - s.equity >= c.maxDrawdown)
    return `Max drawdown reached (${(s.peakEquity - s.equity).toFixed(2)})`;
  if (s.consecLosses >= c.maxConsecLosses)
    return `Max consecutive losses reached (${s.consecLosses})`;
  return null;
}

/** Return the configured stake, optionally doubling only the entry after a loss. */
export function nextStake(
  fixedStake: number,
  history: { profit: number }[],
  doubleAfterLoss = false,
): number {
  return doubleAfterLoss && history[0]?.profit < 0 ? fixedStake * 2 : fixedStake;
}

export function cycleTarget(startBalance: number) {
  return startBalance * 3;
}

export function cycleComplete(startBalance: number, cycleProfit: number): boolean {
  return startBalance > 0 && startBalance + cycleProfit >= cycleTarget(startBalance);
}

/** Pick the qualifying market with the strongest difference. Ties -> first. */
export function rankMarkets<
  T extends { symbol: string; analysis: Analysis; fresh: boolean; confirmed: boolean },
>(ms: T[]) {
  return ms
    .filter((m) => m.fresh && m.analysis.qualifies && m.confirmed)
    .sort((a, b) => b.analysis.difference - a.analysis.difference);
}

// ---- Historical simulation (backtest) ----
export interface BacktestResult {
  trades: number;
  wins: number;
  losses: number;
  net: number;
  rejectedEV: number;
}

export function backtest(
  quotes: number[],
  pipSize: number,
  cfg: {
    sampleSize: number;
    minSample: number;
    minDifference?: number;
    stake: number;
    payoutOver2: number;
    payoutUnder7: number;
    minEV: number;
  },
): BacktestResult {
  const r: BacktestResult = { trades: 0, wins: 0, losses: 0, net: 0, rejectedEV: 0 };
  const digits = quotes.map((q) => lastDigit(q, pipSize));
  for (let i = cfg.sampleSize + 1; i < quotes.length - 1; i++) {
    const win = quotes.slice(0, i + 1);
    const a = analyze(win, cfg.sampleSize, cfg.minSample, cfg.minDifference);
    const conf = analyze(win.slice(0, -1), cfg.sampleSize, cfg.minSample, cfg.minDifference);
    if (!a.direction || conf.direction !== a.direction) continue;
    if (!entryDigitOk(a.direction, digits[i])) continue;
    const dist = digitDistribution(digits.slice(Math.max(0, i - cfg.sampleSize), i + 1));
    const p = a.direction === "OVER2" ? dist.pOver2 : dist.pUnder7;
    const payout = a.direction === "OVER2" ? cfg.payoutOver2 : cfg.payoutUnder7;
    if (expectedValue(p, cfg.stake, payout) <= cfg.minEV) {
      r.rejectedEV++;
      continue;
    }
    const next = digits[i + 1];
    const won = a.direction === "OVER2" ? next > 2 : next < 7;
    r.trades++;
    if (won) {
      r.wins++;
      r.net += payout - cfg.stake;
    } else {
      r.losses++;
      r.net -= cfg.stake;
    }
    i++; // one active trade at a time: skip the settlement tick
  }
  r.net = round2(r.net);
  return r;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
