import {
  analyze,
  backtest,
  buildProposalRequest,
  cycleComplete,
  cycleTarget,
  digitDistribution,
  evaluateEntry,
  expectedValue,
  lastDigit,
  nextStake,
  pipSizeFromPip,
  rankMarkets,
  rejectionMessage,
  riskBlock,
  validateProposal,
  CONTRACTS,
  CONTRACT_DURATION,
  DURATION_UNIT,
  buildAccumulatorProposalRequest,
  learningBlock,
  type Analysis,
  type BacktestResult,
  type Check,
  type Direction,
  type LearningPattern,
  validateAccumulatorProposal,
} from "./strategy";
import { DEFAULT_GROQ_MODELS, listGroqModels, requestGroqPlan, requestGroqSignal } from "./groq";
import { copilotStatus, requestCopilotPlan } from "./copilot";

export const VOL_SYMBOLS = [
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",
  "1HZ10V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ100V",
];
const LS = "deriv-ou-bot-v1";
const DEMO_TRADES_REQUIRED = 20;
export type TradeMode = "auto-over-under" | "over-only" | "under-only" | "accumulator";

export interface Config {
  appId: string;
  tradeMode: TradeMode;
  minDifference: number;
  doubleConfirmation: boolean;
  fastEntry: boolean;
  doubleAfterLoss: boolean;
  skipAfterWins: number;
  skipEntries: number;
  stake: number;
  maxDailyLoss: number;
  dailyProfitTarget: number;
  maxDrawdown: number;
  maxConsecLosses: number;
  sampleSize: number;
  minSample: number;
  cooldownSec: number;
  autoSwitch: boolean;
  manualSymbol: string;
  autoRestart: boolean;
  maxTickAgeMs: number;
  maxLatencyMs: number;
  minEV: number;
  accumulatorGrowthRate: number;
  accumulatorCashOutMultiplier: number;
  accumulatorAutoGrowth: boolean;
  accumulatorRecoveryMode: boolean;
}
export interface Market {
  symbol: string;
  name: string;
  pip: number;
  quotes: number[];
  epochs: number[];
  lastTickAt: number | null;
  analysis: Analysis;
  confirm: Analysis;
  reject: string;
  accumulatorSupported: boolean;
  accumulatorGrowthRates: number[];
}
export interface TradeRec {
  id: string;
  time: number;
  symbol: string;
  direction: Direction;
  entryDigit: number;
  stake: number;
  payout: number;
  profit: number;
  won: boolean;
  virtual: boolean;
  contractId: number;
  strategy?: "over-under" | "accumulator";
  growthRate?: number;
  cashOutTarget?: number;
  exitReason?: string;
}
export interface CycleRec {
  start: number;
  end: number;
  profit: number;
  wins: number;
  losses: number;
  startedAt: number;
  endedAt: number;
  tradeIds: string[];
}
export interface LogRec {
  t: number;
  kind: "accept" | "reject" | "exec" | "settle" | "switch" | "error" | "info";
  msg: string;
}
export type LossCause =
  "weak-signal" | "poor-value" | "execution-risk" | "normal-variance" | "insufficient-evidence";
export interface LossLog {
  id: string;
  time: number;
  symbol: string;
  direction: Direction;
  entryDigit: number;
  exitDigit: number | null;
  stake: number;
  payout: number;
  loss: number;
  virtual: boolean;
  contractId: number;
  cause: LossCause;
  reason: string;
  signalEpoch: number | null;
  settledEpoch: number | null;
  analysis: Analysis;
  confirmation: Analysis;
  pWin: number;
  expectedValue: number;
  latencyMs: number | null;
  tickAgeMs: number | null;
  proposalAgeMs: number | null;
  entryChecks: Check[];
  proposalChecks: Check[];
  consecutiveLosses: number;
  dailyPnl: number;
}
export interface LearningState {
  total: number;
  wins: number;
  losses: number;
  patterns: Record<string, LearningPattern>;
  updatedAt: number | null;
}
type Phase = "none" | "proposing" | "buying" | "open" | "reconciling";
type DecisionMeta = {
  signalEpoch: number | null;
  analysis: Analysis;
  confirmation: Analysis;
  pWin: number;
  expectedValue: number;
  latencyMs: number | null;
  tickAgeMs: number | null;
  proposalAgeMs: number | null;
  entryChecks: Check[];
  proposalChecks: Check[];
};

export interface State {
  config: Config;
  status: "idle" | "running" | "paused" | "stopped" | "emergency";
  connected: boolean;
  authorized: boolean;
  latencyMs: number | null;
  account: { loginid: string; isVirtual: boolean; currency: string; balance: number } | null;
  accounts: { id: string; isVirtual: boolean; currency: string; balance: number }[];
  selectedAccount: string | null;
  markets: Record<string, Market>;
  active: string;
  marketSwitchPendingLoss: boolean;
  skipWins: number;
  skipEntriesRemaining: number;
  phase: Phase;
  currentDirection: Direction | null;
  contractId: number | null;
  contractMode: "over-under" | "accumulator" | null;
  accumulator: {
    growthRate: number | null;
    target: number | null;
    currentValue: number | null;
    peakValue: number | null;
    soldFor: number | null;
    sellRequested: boolean;
    recoveryOutstanding: number;
    totalRecovered: number;
  };
  lastSettledAt: number;
  cycle: {
    start: number;
    profit: number;
    wins: number;
    losses: number;
    startedAt: number;
    tradeIds: string[];
    peak: number;
  } | null;
  day: { date: string; pnl: number };
  consecLosses: number;
  checks: Check[];
  proposalChecks: Check[];
  logs: LogRec[];
  trades: TradeRec[];
  lossLogs: LossLog[];
  cycles: CycleRec[];
  learning: LearningState;
  realEnabled: boolean;
  backtestDone: boolean;
  backtest: (BacktestResult & { symbol: string }) | null;
  haltReason: string | null;
  ai: {
    enabled: boolean;
    autonomous: boolean;
    provider: "groq" | "copilot";
    copilotBaseUrl: string;
    copilotConnected: boolean;
    configured: boolean;
    model: string;
    models: string[];
    busy: boolean;
    lastDecision: string | null;
    error: string | null;
  };
}

const emptyA: Analysis = {
  sufficient: false,
  moves: 0,
  bullish: 0,
  bearish: 0,
  difference: 0,
  trend: "FLAT",
  qualifies: false,
  direction: null,
};
const today = () => new Date().toISOString().slice(0, 10);

export const defaultConfig: Config = {
  appId: "",
  tradeMode: "auto-over-under",
  minDifference: 5,
  doubleConfirmation: true,
  fastEntry: false,
  doubleAfterLoss: false,
  skipAfterWins: 0,
  skipEntries: 0,
  stake: 1,
  maxDailyLoss: 10,
  dailyProfitTarget: 0,
  maxDrawdown: 10,
  maxConsecLosses: 5,
  sampleSize: 50,
  minSample: 30,
  cooldownSec: 3,
  autoSwitch: true,
  manualSymbol: "R_100",
  autoRestart: true,
  maxTickAgeMs: 4000,
  maxLatencyMs: 1500,
  minEV: 0,
  accumulatorGrowthRate: 0.03,
  accumulatorCashOutMultiplier: 2,
  accumulatorAutoGrowth: true,
  accumulatorRecoveryMode: false,
};

class Engine {
  state: State = {
    config: { ...defaultConfig },
    status: "idle",
    connected: false,
    authorized: false,
    latencyMs: null,
    account: null,
    accounts: [],
    selectedAccount: null,
    markets: {},
    active: "R_100",
    marketSwitchPendingLoss: false,
    skipWins: 0,
    skipEntriesRemaining: 0,
    phase: "none",
    currentDirection: null,
    contractId: null,
    contractMode: null,
    accumulator: {
      growthRate: null,
      target: null,
      currentValue: null,
      peakValue: null,
      soldFor: null,
      sellRequested: false,
      recoveryOutstanding: 0,
      totalRecovered: 0,
    },
    lastSettledAt: 0,
    cycle: null,
    day: { date: today(), pnl: 0 },
    consecLosses: 0,
    checks: [],
    proposalChecks: [],
    logs: [],
    trades: [],
    lossLogs: [],
    cycles: [],
    learning: { total: 0, wins: 0, losses: 0, patterns: {}, updatedAt: null },
    realEnabled: false,
    backtestDone: false,
    backtest: null,
    haltReason: null,
    ai: {
      enabled: false,
      autonomous: false,
      provider: "groq",
      copilotBaseUrl: "http://localhost:8787",
      copilotConnected: false,
      configured: false,
      model: "llama-3.3-70b-versatile",
      models: [...DEFAULT_GROQ_MODELS],
      busy: false,
      lastDecision: null,
      error: null,
    },
  };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private token = ""; // memory only, never persisted
  private reqId = 1;
  private pending = new Map<number, (m: any) => void>();
  private pingTimer: any = null;
  private manualClose = false;
  private lastReject = "";
  private buySentAt = 0;
  private inited = false;
  private groqApiKey = "";
  private lastAiPlanAt = 0;
  private aiRetryAfter = 0;
  private lastAiError = "";

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  private set(p: Partial<State>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }
  private persist() {
    const {
      config,
      marketSwitchPendingLoss,
      skipWins,
      skipEntriesRemaining,
      trades,
      cycles,
      lossLogs,
      logs,
      day,
      consecLosses,
      backtestDone,
      learning,
      accumulator,
    } = this.state;
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({
          config,
          marketSwitchPendingLoss,
          skipWins,
          skipEntriesRemaining,
          trades,
          cycles,
          lossLogs: lossLogs.slice(0, 300),
          logs: logs.slice(0, 300),
          day,
          consecLosses,
          backtestDone,
          learning,
          accumulator,
        }),
      );
    } catch {
      /* ignore */
    }
  }
  init() {
    if (this.inited) return;
    this.inited = true;
    try {
      const s = JSON.parse(localStorage.getItem(LS) || "null");
      if (s) {
        const config = { ...defaultConfig, ...s.config };
        // Older saved state could contain an invalid threshold such as 128,
        // which prevents almost every signal from becoming tradable.
        config.minDifference =
          Number.isFinite(config.minDifference) &&
          config.minDifference >= 0 &&
          config.minDifference <= 100
            ? config.minDifference
            : defaultConfig.minDifference;
        this.set({
          ...s,
          config,
          marketSwitchPendingLoss: !!s.marketSwitchPendingLoss,
          skipWins: Number.isInteger(s.skipWins) && s.skipWins > 0 ? s.skipWins : 0,
          skipEntriesRemaining:
            Number.isInteger(s.skipEntriesRemaining) && s.skipEntriesRemaining > 0
              ? s.skipEntriesRemaining
              : 0,
          lossLogs: Array.isArray(s.lossLogs) ? s.lossLogs : [],
          accumulator: { ...this.state.accumulator, ...(s.accumulator ?? {}) },
          learning: s.learning?.patterns
            ? {
                total: Number(s.learning.total ?? 0),
                wins: Number(s.learning.wins ?? 0),
                losses: Number(s.learning.losses ?? 0),
                patterns: s.learning.patterns,
                updatedAt: s.learning.updatedAt ?? null,
              }
            : this.state.learning,
          day: s.day?.date === today() ? s.day : { date: today(), pnl: 0 },
        });
      }
    } catch {
      /* ignore */
    }
  }
  log(kind: LogRec["kind"], msg: string) {
    this.set({ logs: [{ t: Date.now(), kind, msg }, ...this.state.logs].slice(0, 500) });
    if (kind !== "reject") this.persist();
  }

  updateConfig(p: Partial<Config>) {
    if (this.state.phase !== "none" && "stake" in p) {
      this.log("error", "Stake change refused — a trade is in progress.");
      delete p.stake;
    }
    if (p.stake !== undefined && !(p.stake >= 0.35)) {
      this.log("error", "Stake must be at least 0.35.");
      delete p.stake;
    }
    if (
      p.dailyProfitTarget !== undefined &&
      (!Number.isFinite(p.dailyProfitTarget) || p.dailyProfitTarget < 0)
    ) {
      this.log("error", "Daily profit target must be 0 or greater.");
      delete p.dailyProfitTarget;
    }
    if (
      p.minDifference !== undefined &&
      (!Number.isFinite(p.minDifference) || p.minDifference < 0 || p.minDifference > 100)
    ) {
      this.log("error", "Bull/bear difference must be between 0 and 100.");
      delete p.minDifference;
    }
    if (
      p.accumulatorCashOutMultiplier !== undefined &&
      (!Number.isFinite(p.accumulatorCashOutMultiplier) || p.accumulatorCashOutMultiplier < 1.25)
    ) {
      this.log("error", "Accumulator cash-out multiplier must be at least 1.25.");
      delete p.accumulatorCashOutMultiplier;
    }
    if (
      p.accumulatorGrowthRate !== undefined &&
      (!Number.isFinite(p.accumulatorGrowthRate) ||
        p.accumulatorGrowthRate < 0.01 ||
        p.accumulatorGrowthRate > 0.05)
    ) {
      this.log("error", "Accumulator growth must be between 1% and 5%.");
      delete p.accumulatorGrowthRate;
    }
    for (const key of ["skipAfterWins", "skipEntries"] as const) {
      if (p[key] !== undefined && (!Number.isInteger(p[key]) || p[key] < 0 || p[key] > 1000)) {
        this.log("error", `${key} must be a whole number between 0 and 1000.`);
        delete p[key];
      }
    }
    const config = { ...this.state.config, ...p };
    this.set({ config });
    if (config.skipAfterWins === 0 || config.skipEntries === 0)
      this.set({ skipWins: 0, skipEntriesRemaining: 0 });
    if (
      !config.autoSwitch &&
      config.manualSymbol !== this.state.active &&
      this.state.phase === "none"
    ) {
      const next = this.state.markets[config.manualSymbol];
      if (next) {
        const previous = this.state.markets[this.state.active];
        this.set({ active: config.manualSymbol, marketSwitchPendingLoss: false });
        this.log(
          "switch",
          `MANUAL MARKET — ${previous?.name ?? this.state.active} → ${next.name}.`,
        );
      }
    }
    if (p.minDifference !== undefined) {
      const markets = Object.fromEntries(
        Object.entries(this.state.markets).map(([symbol, market]) => [
          symbol,
          this.recompute(market),
        ]),
      );
      this.set({ markets });
    }
    this.persist();
  }
  demoTradesSettled() {
    return this.state.trades.filter((t) => t.virtual).length;
  }
  canEnableReal() {
    return this.demoTradesSettled() >= DEMO_TRADES_REQUIRED && this.state.backtestDone;
  }
  enableReal(confirmText: string) {
    if (this.state.ai.enabled || this.state.ai.autonomous) {
      this.log("error", "Real trading is disabled while Groq AI mode is enabled. Use demo only.");
      return;
    }
    if (!this.canEnableReal()) {
      this.log(
        "error",
        `Real trading needs ${DEMO_TRADES_REQUIRED} settled demo trades and a completed backtest.`,
      );
      return;
    }
    if (confirmText !== "ENABLE REAL") {
      this.log("error", "Confirmation text did not match.");
      return;
    }
    this.set({ realEnabled: true });
    this.log("info", "Real-money trading explicitly enabled by user.");
  }
  disableReal() {
    this.set({ realEnabled: false });
    this.log("info", "Real-money trading disabled.");
  }

  configureGroq(apiKey: string, model: string, enabled: boolean) {
    this.groqApiKey = apiKey.trim();
    const selectedModel = model.trim() || "llama-3.3-70b-versatile";
    this.set({
      ai: {
        ...this.state.ai,
        enabled,
        autonomous: enabled ? this.state.ai.autonomous : false,
        configured: !!this.groqApiKey,
        model: selectedModel,
        error: null,
      },
    });
  }

  setAIProvider(provider: "groq" | "copilot") {
    if (this.state.status === "running") {
      this.log("error", "Stop the bot before changing AI providers.");
      return;
    }
    this.set({ ai: { ...this.state.ai, provider, autonomous: false, error: null } });
  }

  setAIEnabled(enabled: boolean) {
    if (enabled && !this.state.ai.configured) {
      this.log("error", "Connect or configure the selected AI provider first.");
      return;
    }
    this.set({
      ai: {
        ...this.state.ai,
        enabled,
        autonomous: enabled && (this.state.ai.provider === "copilot" || this.state.ai.autonomous),
      },
    });
  }

  setCopilotBaseUrl(baseUrl: string) {
    this.set({ ai: { ...this.state.ai, copilotBaseUrl: baseUrl.trim().replace(/\/$/, "") } });
  }

  connectCopilot() {
    if (typeof window === "undefined") return;
    window.open(
      `${this.state.ai.copilotBaseUrl}/auth/login`,
      "copilot-oauth",
      "popup,width=600,height=750",
    );
  }

  async refreshCopilotStatus() {
    try {
      const result = await copilotStatus(this.state.ai.copilotBaseUrl);
      this.set({
        ai: {
          ...this.state.ai,
          copilotConnected: result.connected,
          configured: result.connected,
          error: result.connected ? null : this.state.ai.error,
        },
      });
    } catch (error) {
      this.set({
        ai: {
          ...this.state.ai,
          copilotConnected: false,
          error: error instanceof Error ? error.message : "Copilot service unavailable",
        },
      });
    }
  }

  async discoverGroqModels(apiKey: string) {
    const key = apiKey.trim();
    if (!key) return;
    this.groqApiKey = key;
    this.set({ ai: { ...this.state.ai, configured: false, busy: true, error: null } });
    try {
      const models = await listGroqModels(key);
      if (!models.length) throw new Error("No active chat models are available for this key");
      this.set({
        ai: {
          ...this.state.ai,
          configured: true,
          busy: false,
          models,
          model: models[0],
          error: null,
        },
      });
      this.log("info", `Groq key verified — selected best available model ${models[0]}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not load Groq models";
      this.set({ ai: { ...this.state.ai, configured: false, busy: false, error: detail } });
      this.log("error", `Groq model discovery failed — ${detail}.`);
    }
  }

  setGroqAutonomous(autonomous: boolean) {
    if (autonomous && (!this.state.ai.enabled || !this.state.ai.configured)) {
      this.log("error", "Enable and configure the selected AI provider before autonomous mode.");
      return;
    }
    this.set({ ai: { ...this.state.ai, autonomous } });
  }

  clearGroq() {
    this.groqApiKey = "";
    this.set({
      ai: {
        ...this.state.ai,
        enabled: false,
        autonomous: false,
        configured: false,
        models: [...DEFAULT_GROQ_MODELS],
        busy: false,
        error: null,
      },
    });
  }

  // ---------- connection ----------
  // New Deriv API (PAT tokens "pat_..."): REST lists accounts, then an OTP gives a one-time WebSocket URL.
  // Legacy tokens: old WebSocket + authorize call.
  private isPat() {
    return this.token.startsWith("pat_");
  }
  private rest(path: string, method = "GET") {
    return fetch(`https://api.derivws.com/trading/v1/options${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Deriv-App-ID": this.state.config.appId.trim(),
      },
    }).then(async (r) => {
      const txt = await r.text();
      let j: any = null;
      try {
        j = JSON.parse(txt);
      } catch {
        /* text */
      }
      if (!r.ok) throw new Error(j?.errors?.[0]?.message ?? (txt || `HTTP ${r.status}`));
      return j;
    });
  }
  async connect(token: string) {
    this.token = token.trim();
    this.manualClose = false;
    if (!this.token) return;
    if (this.isPat()) {
      const aid = this.state.config.appId.trim();
      if (!aid || aid === "1089") {
        this.log(
          "error",
          "pat_ tokens need your own App ID: register an app at developers.deriv.com and paste its App ID in the App ID box.",
        );
        return;
      }
      this.log("info", "Checking token with Deriv…");
      try {
        const r = await this.rest("/accounts");
        const list: any[] = Array.isArray(r) ? r : (r?.data ?? r?.accounts ?? []);
        const accounts = list.map((a) => ({
          id: String(a.account_id ?? a.loginid ?? a.id),
          isVirtual: a.account_type
            ? String(a.account_type).toLowerCase() === "demo"
            : !!(a.is_virtual ?? a.is_demo),
          currency: a.currency ?? "USD",
          balance: Number(a.balance ?? 0),
        }));
        if (!accounts.length) {
          this.log("error", "No Options trading accounts found for this token.");
          return;
        }
        const pick =
          accounts.find((a) => a.id === this.state.selectedAccount) ??
          accounts.find((a) => a.isVirtual) ??
          accounts[0];
        this.set({ accounts, selectedAccount: pick.id });
        this.log(
          "info",
          `Found ${accounts.length} account(s). Using ${pick.id} (${pick.isVirtual ? "DEMO" : "REAL"}).`,
        );
      } catch (e: any) {
        const msg = String(e.message);
        this.log(
          "error",
          `Token check failed: ${msg}${/application/i.test(msg) ? " — the App ID must be one you registered at developers.deriv.com (old App IDs like 1089 don't work with pat_ tokens)." : ""}`,
        );
        return;
      }
    }
    this.open();
  }
  selectAccount(id: string) {
    if (this.state.phase !== "none" || this.state.status === "running") {
      this.log("error", "Stop the bot before switching accounts.");
      return;
    }
    if (this.state.ai.enabled) {
      const selected = this.state.accounts.find((account) => account.id === id);
      if (selected && !selected.isVirtual) {
        this.log("error", "Groq AI mode is demo-only. Select a virtual account.");
        return;
      }
    }
    this.set({ selectedAccount: id, cycle: null });
    this.log("info", `Switching to account ${id}.`);
    if (this.token) this.open();
  }
  disconnect() {
    this.manualClose = true;
    if (this.state.phase !== "none") {
      this.stop("Disconnected by user; waiting for the active contract to settle");
    } else {
      this.resetDisconnectedSession();
    }
    this.ws?.close();
  }

  private resetDisconnectedSession() {
    this.set({
      status: "idle",
      connected: false,
      authorized: false,
      account: null,
      accounts: [],
      selectedAccount: null,
      latencyMs: null,
      cycle: null,
      consecLosses: 0,
      checks: [],
      proposalChecks: [],
      trades: [],
      lossLogs: [],
      cycles: [],
      logs: [],
      day: { date: today(), pnl: 0 },
      contractId: null,
      contractMode: null,
      currentDirection: null,
      marketSwitchPendingLoss: false,
      skipWins: 0,
      skipEntriesRemaining: 0,
      phase: "none",
      haltReason: null,
    });
    this.persist();
    this.pending.forEach((r) => r({ error: { message: "Disconnected by user" } }));
    this.pending.clear();
    this.pendingMeta.clear();
    this.lastDecisionMeta = null;
    this.lastReject = "";
  }
  private async open() {
    const old = this.ws;
    this.ws = null;
    old?.close();
    let url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(this.state.config.appId || "1089")}`;
    if (this.isPat()) {
      try {
        const r = await this.rest(
          `/accounts/${encodeURIComponent(this.state.selectedAccount ?? "")}/otp`,
          "POST",
        );
        url = r?.data?.url ?? r?.url;
        if (!url) throw new Error("No WebSocket URL in OTP response");
      } catch (e: any) {
        this.log("error", `Could not open trading connection: ${e.message}`);
        if (!this.manualClose) setTimeout(() => this.open(), 5000);
        return;
      }
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = async () => {
      this.set({ connected: true });
      this.log("info", "API connected.");
      this.startPing();
      if (this.isPat()) {
        const acc = this.state.accounts.find((a) => a.id === this.state.selectedAccount)!;
        this.set({
          authorized: true,
          account: {
            loginid: acc.id,
            isVirtual: acc.isVirtual,
            currency: acc.currency,
            balance: acc.balance,
          },
        });
        this.log("info", `Authorized ${acc.id} (${acc.isVirtual ? "DEMO" : "REAL"}).`);
        this.send({ balance: 1, subscribe: 1 }).then((b) => {
          if (b.error) this.log("error", `Balance: ${b.error.message}`);
        });
      } else if (this.token) await this.authorize();
      await this.loadMarkets();
      if (
        this.state.phase === "buying" ||
        this.state.phase === "open" ||
        this.state.phase === "reconciling"
      )
        await this.reconcile();
    };
    ws.onerror = () => {
      if (this.ws === ws) this.log("error", "WebSocket error.");
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.set({ connected: false, authorized: false, latencyMs: null });
      clearInterval(this.pingTimer);
      this.pending.forEach((r) => r({ error: { message: "Connection closed" } }));
      this.pending.clear();
      if (this.state.phase === "buying" || this.state.phase === "open")
        this.set({ phase: "reconciling" });
      if (!this.manualClose) this.log("error", "API connection lost — trading suspended.");
      if (!this.manualClose) setTimeout(() => this.open(), 2000);
    };
  }
  private send(req: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1)
        return resolve({ error: { message: "Not connected" } });
      const id = this.reqId++;
      const to = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ error: { message: "Timeout", code: "Timeout" } });
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(to);
        resolve(m);
      });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
    });
  }
  private startPing() {
    clearInterval(this.pingTimer);
    const ping = async () => {
      const t = Date.now();
      const r = await this.send({ ping: 1 }, 5000);
      this.set({ latencyMs: r.error ? null : Date.now() - t });
    };
    ping();
    this.pingTimer = setInterval(ping, 5000);
  }
  private async authorize() {
    const r = await this.send({ authorize: this.token });
    if (r.error) {
      this.log("error", `Authorization failed: ${r.error.message}`);
      return;
    }
    const a = r.authorize;
    this.set({
      authorized: true,
      account: {
        loginid: a.loginid,
        isVirtual: !!a.is_virtual,
        currency: a.currency,
        balance: Number(a.balance),
      },
    });
    this.log("info", `Authorized ${a.loginid} (${a.is_virtual ? "DEMO" : "REAL"}).`);
    this.send({ balance: 1, subscribe: 1 });
  }
  private async loadMarkets() {
    const r = await this.send({ active_symbols: "brief" });
    if (r.error) {
      this.log("error", `active_symbols failed: ${r.error.message}`);
      return;
    }
    const avail = (r.active_symbols as any[]).filter(
      (s) =>
        VOL_SYMBOLS.includes(s.underlying_symbol ?? s.symbol) &&
        s.exchange_is_open &&
        !s.is_trading_suspended,
    );
    const markets: Record<string, Market> = {};
    for (const s of avail)
      markets[s.underlying_symbol ?? s.symbol] = {
        symbol: s.underlying_symbol ?? s.symbol,
        name: s.underlying_symbol_name ?? s.display_name,
        pip: pipSizeFromPip(Number(s.pip_size ?? s.pip)),
        quotes: [],
        epochs: [],
        lastTickAt: null,
        analysis: emptyA,
        confirm: emptyA,
        reject: "Loading history",
        accumulatorSupported: false,
        accumulatorGrowthRates: [],
      };
    this.set({ markets });
    await this.send({ forget_all: "ticks" });
    const count = Math.max(this.state.config.sampleSize + 2, 1000);
    await Promise.all(
      Object.keys(markets).map(async (sym) => {
        const cf = await this.send({ contracts_for: sym });
        const available = Array.isArray(cf.contracts_for?.available)
          ? cf.contracts_for.available
          : [];
        const accumulatorContract = available.find(
          (x: any) =>
            String(x.contract_type ?? "").toUpperCase() === "ACCU" ||
            /accumulator/i.test(String(x.contract_category ?? "")),
        );
        const rates = (accumulatorContract?.growth_rate ??
          accumulatorContract?.growth_rates ??
          []) as unknown;
        const accumulatorGrowthRates = Array.isArray(rates)
          ? rates.map(Number).filter((x: number) => Number.isFinite(x) && x > 0)
          : typeof rates === "number" || typeof rates === "string"
            ? [Number(rates)].filter((x) => Number.isFinite(x) && x > 0)
            : [];
        const current = this.state.markets[sym];
        if (current)
          this.set({
            markets: {
              ...this.state.markets,
              [sym]: {
                ...current,
                accumulatorSupported: !!accumulatorContract,
                accumulatorGrowthRates,
              },
            },
          });
        const h = await this.send({
          ticks_history: sym,
          count,
          end: "latest",
          style: "ticks",
          subscribe: 1,
        });
        if (h.error) {
          this.log("error", `${sym} history failed: ${h.error.message}`);
          return;
        }
        const m = this.state.markets[sym];
        if (!m) return;
        const pip = h.pip_size ?? m.pip;
        this.set({
          markets: {
            ...this.state.markets,
            [sym]: this.recompute({
              ...m,
              pip,
              quotes: h.history.prices.map(Number),
              epochs: h.history.times.map(Number),
              lastTickAt: Date.now(),
            }),
          },
        });
      }),
    );
    this.log("info", `Streaming ${Object.keys(markets).length} volatility markets.`);
  }
  private recompute(m: Market): Market {
    const { sampleSize, minSample } = this.state.config;
    return {
      ...m,
      analysis: analyze(m.quotes, sampleSize, minSample, this.state.config.minDifference),
      confirm: analyze(
        m.quotes.slice(0, -1),
        sampleSize,
        minSample,
        this.state.config.minDifference,
      ),
    };
  }

  private learningKey(symbol: string, direction: Direction, entryDigit: number) {
    return `${symbol}|${direction}|entry-${entryDigit}`;
  }
  private learnedBlock(symbol: string, direction: Direction | null, entryDigit: number | null) {
    if (!direction || entryDigit === null) return null;
    return learningBlock(
      this.state.learning.patterns[this.learningKey(symbol, direction, entryDigit)],
    );
  }
  private recordLearning(trade: TradeRec): LearningState {
    const key = this.learningKey(trade.symbol, trade.direction, trade.entryDigit);
    const previous = this.state.learning.patterns[key] ?? {
      trades: 0,
      wins: 0,
      losses: 0,
      profit: 0,
    };
    const pattern = {
      trades: previous.trades + 1,
      wins: previous.wins + (trade.won ? 1 : 0),
      losses: previous.losses + (trade.won ? 0 : 1),
      profit: previous.profit + trade.profit,
    };
    return {
      total: this.state.learning.total + 1,
      wins: this.state.learning.wins + (trade.won ? 1 : 0),
      losses: this.state.learning.losses + (trade.won ? 0 : 1),
      patterns: { ...this.state.learning.patterns, [key]: pattern },
      updatedAt: Date.now(),
    };
  }

  private onMessage(m: any) {
    if (m.req_id && this.pending.has(m.req_id)) {
      const r = this.pending.get(m.req_id)!;
      this.pending.delete(m.req_id);
      r(m);
    }
    if (m.msg_type === "tick" && m.tick) this.onTick(m.tick);
    if (m.msg_type === "balance" && m.balance && this.state.account)
      this.set({
        account: {
          ...this.state.account,
          balance: Number(m.balance.balance),
          currency: m.balance.currency || this.state.account.currency,
        },
      });
    if (m.msg_type === "proposal_open_contract" && m.proposal_open_contract)
      this.onContract(m.proposal_open_contract);
  }

  private onTick(t: any) {
    const m = this.state.markets[t.symbol];
    if (!m) return;
    if (m.epochs.length && Number(t.epoch) <= m.epochs[m.epochs.length - 1]) return;
    const keep = Math.max(this.state.config.sampleSize + 2, 1000);
    const nm = this.recompute({
      ...m,
      pip: t.pip_size ?? m.pip,
      quotes: [...m.quotes, Number(t.quote)].slice(-keep),
      epochs: [...m.epochs, Number(t.epoch)].slice(-keep),
      lastTickAt: Date.now(),
    });
    nm.reject = !nm.analysis.sufficient
      ? "Insufficient sample"
      : !nm.analysis.qualifies
        ? `Difference ${nm.analysis.difference} < ${this.state.config.minDifference}`
        : nm.confirm.direction !== nm.analysis.direction
          ? "Direction not double-confirmed"
          : "Qualifies";
    this.set({ markets: { ...this.state.markets, [t.symbol]: nm } });
    this.maybeSwitch();
    if (t.symbol === this.state.active) this.evaluate();
  }

  private maybeSwitch() {
    const s = this.state;
    if (s.phase !== "none" || s.ai.autonomous) return;
    if (!s.config.autoSwitch) {
      if (s.active !== s.config.manualSymbol) this.set({ active: s.config.manualSymbol });
      return;
    }
    const now = Date.now();
    const allowsMode = (direction: Direction | null) =>
      s.config.tradeMode === "auto-over-under" || s.config.tradeMode === "accumulator"
        ? true
        : s.config.tradeMode === "over-only"
          ? direction === "OVER2"
          : direction === "UNDER7";
    const ranked = rankMarkets(
      Object.values(s.markets)
        .filter((m) => allowsMode(m.analysis.direction))
        .map((m) => ({
          ...m,
          fresh: !!m.lastTickAt && now - m.lastTickAt <= s.config.maxTickAgeMs,
          confirmed:
            s.config.fastEntry ||
            !s.config.doubleConfirmation ||
            m.confirm.direction === m.analysis.direction,
        })),
    );
    const best = ranked[0];
    const currentRanked = ranked.find((m) => m.symbol === s.active);
    const candidate = s.marketSwitchPendingLoss ? ranked.find((m) => m.symbol !== s.active) : best;
    if (
      candidate &&
      candidate.symbol !== s.active &&
      (!currentRanked ||
        s.marketSwitchPendingLoss ||
        candidate.analysis.difference > currentRanked.analysis.difference)
    ) {
      this.set({ active: candidate.symbol, marketSwitchPendingLoss: false });
      this.log(
        "switch",
        `MARKET SWITCHED — ${s.markets[s.active]?.name ?? s.active}: ${s.markets[s.active]?.reject ?? "unavailable"}. Now ${candidate.name} (${CONTRACTS[candidate.analysis.direction ?? "OVER2"].label}, difference ${candidate.analysis.difference}).`,
      );
      this.lastReject = "";
    }
  }

  private context(sym: string) {
    const s = this.state;
    const m = s.markets[sym];
    const now = Date.now();
    const c = s.config;
    const equity = s.cycle ? s.cycle.start + s.cycle.profit : 0;
    let rb = s.cycle
      ? riskBlock(
          { dailyPnl: s.day.pnl, peakEquity: s.cycle.peak, equity, consecLosses: s.consecLosses },
          c,
        )
      : "Cycle not started";
    if (!rb && s.status !== "running") rb = `Bot is ${s.status}`;
    const stake = nextStake(c.stake, s.trades);
    const rawAnalysis = m?.analysis ?? emptyA;
    const rawConfirm = m?.confirm ?? emptyA;
    const modeAnalysis = (analysis: Analysis): Analysis => {
      if (c.tradeMode === "over-only" && analysis.direction !== "OVER2")
        return { ...analysis, qualifies: false, direction: null };
      if (c.tradeMode === "under-only" && analysis.direction !== "UNDER7")
        return { ...analysis, qualifies: false, direction: null };
      return analysis;
    };
    return evaluateEntry({
      connected: s.connected,
      authorized: s.authorized,
      latencyMs: s.latencyMs,
      maxLatencyMs: c.maxLatencyMs,
      tickAgeMs: m?.lastTickAt ? now - m.lastTickAt : null,
      maxTickAgeMs: c.maxTickAgeMs,
      symbolSupported: !!m,
      analysis: modeAnalysis(rawAnalysis),
      confirmAnalysis: modeAnalysis(rawConfirm),
      latestDigit: m && m.quotes.length ? lastDigit(m.quotes[m.quotes.length - 1], m.pip) : null,
      stake,
      fixedStake: c.stake,
      doubleAfterLoss: c.doubleAfterLoss,
      balance: s.account?.balance ?? null,
      busy: s.phase !== "none",
      riskBlock: rb,
      cooldownRemainingMs: c.fastEntry ? 0 : s.lastSettledAt + c.cooldownSec * 1000 - now,
      realAccountBlocked: !!s.account && !s.account.isVirtual && !s.realEnabled,
      minDifference: c.minDifference,
      checkEntryDigit: c.tradeMode !== "accumulator",
      requireConfirmation:
        c.tradeMode === "accumulator" ? true : c.fastEntry ? false : c.doubleConfirmation,
      learningBlock: this.learnedBlock(
        sym,
        m?.analysis.direction ?? null,
        m && m.quotes.length ? lastDigit(m.quotes[m.quotes.length - 1], m.pip) : null,
      ),
    });
  }

  private dailyTargetReached(pnl = this.state.day.pnl) {
    const target = this.state.config.dailyProfitTarget;
    return target > 0 && pnl >= target;
  }

  private consumeSkippedEntry(label: string) {
    const remaining = this.state.skipEntriesRemaining;
    if (remaining <= 0) return false;
    this.set({ skipEntriesRemaining: remaining - 1 });
    this.log("info", `${label} ENTRY SKIPPED — ${remaining - 1} skip(s) remaining.`);
    return true;
  }

  private skipStateAfterSettlement(won: boolean) {
    const c = this.state.config;
    if (c.skipAfterWins <= 0 || c.skipEntries <= 0) return { skipWins: 0, skipEntriesRemaining: 0 };
    if (!won) return { skipWins: 0, skipEntriesRemaining: 0 };
    const wins = this.state.skipWins + 1;
    return wins >= c.skipAfterWins
      ? { skipWins: 0, skipEntriesRemaining: c.skipEntries }
      : { skipWins: wins };
  }

  private evaluate() {
    const s = this.state;
    if (s.status !== "running") {
      this.set({ checks: this.context(s.active).checks });
      return;
    }
    if (this.dailyTargetReached()) {
      this.halt(`Daily take-profit target reached (${s.day.pnl.toFixed(2)}).`);
      return;
    }
    if (s.ai.autonomous) {
      this.evaluateAutonomous();
      return;
    }
    if (s.config.tradeMode === "accumulator") {
      const accumulatorSymbol = s.active;
      const accumulatorMarket = s.markets[accumulatorSymbol];
      const accumulatorContext = this.context(accumulatorSymbol);
      const accumulatorRisk = accumulatorContext.checks.find((check) => check.id === "risk");
      const accumulatorFunds = accumulatorContext.checks.find((check) => check.id === "funds");
      if (
        accumulatorRisk &&
        !accumulatorRisk.pass &&
        !accumulatorRisk.detail.startsWith("Bot is")
      ) {
        this.set({ checks: accumulatorContext.checks });
        this.halt(accumulatorRisk.detail);
        return;
      }
      if (accumulatorFunds && !accumulatorFunds.pass && s.account) {
        this.set({ checks: accumulatorContext.checks });
        this.halt("Balance cannot cover the fixed stake");
        return;
      }
      if (
        accumulatorMarket?.accumulatorSupported &&
        accumulatorContext.direction &&
        accumulatorContext.checks.every((check) => check.pass)
      ) {
        this.set({ checks: accumulatorContext.checks });
        if (this.consumeSkippedEntry("ACCUMULATOR")) return;
        this.attemptAccumulator(accumulatorSymbol, accumulatorContext.direction);
        return;
      }
      const msg = "ACCUMULATOR waiting — no supported, fully validated opportunity is available.";
      if (msg !== this.lastReject) {
        this.lastReject = msg;
        this.log("reject", msg);
      }
      this.set({ checks: this.context(s.active).checks });
      return;
    }
    const sym = s.active;
    const { checks, direction } = this.context(sym);
    const m = s.markets[sym];
    // risk halts
    const risk = checks.find((k) => k.id === "risk");
    if (risk && !risk.pass && s.phase === "none" && !risk.detail.startsWith("Bot is")) {
      this.set({ checks });
      this.halt(risk.detail);
      return;
    }
    const funds = checks.find((k) => k.id === "funds");
    if (funds && !funds.pass && s.account && s.phase === "none") {
      this.set({ checks });
      this.halt("Balance cannot cover the fixed stake");
      return;
    }
    this.set({ checks });
    if (!direction) {
      const msg = rejectionMessage(checks, m?.analysis.direction ?? null);
      if (msg && msg !== this.lastReject) {
        this.lastReject = msg;
        this.log("reject", `[${sym}] ${msg}`);
      }
      return;
    }
    if (this.consumeSkippedEntry(CONTRACTS[direction].label)) return;
    this.attempt(sym, direction, m.epochs[m.epochs.length - 1]);
  }

  private evaluateAutonomous() {
    const s = this.state;
    if (!s.account?.isVirtual) {
      this.halt("Autonomous AI mode is demo-only.");
      return;
    }
    if (!s.ai.enabled || s.phase !== "none" || s.ai.busy) return;
    if (s.ai.provider === "groq" && !this.groqApiKey) return;
    if (s.ai.provider === "copilot" && !s.ai.copilotConnected) return;
    if (Date.now() - this.lastAiPlanAt < 2500 || Date.now() < this.aiRetryAfter) return;
    const now = Date.now();
    const markets = Object.values(s.markets)
      .filter(
        (market) => market.lastTickAt !== null && now - market.lastTickAt <= s.config.maxTickAgeMs,
      )
      .map((market) => ({
        symbol: market.symbol,
        bullish: market.analysis.bullish,
        bearish: market.analysis.bearish,
        difference: market.analysis.difference,
        direction: market.analysis.direction,
        moves: market.analysis.moves,
        fresh: true,
        latestDigits: market.quotes.slice(-20).map((quote) => lastDigit(quote, market.pip)),
      }));
    if (!markets.length) return;
    this.lastAiPlanAt = now;
    this.set({ ai: { ...s.ai, busy: true, error: null } });
    const planInput = {
      markets,
      recentLosses: s.lossLogs.slice(0, 20).map((loss) => ({
        symbol: loss.symbol,
        cause: loss.cause,
        expectedValue: loss.expectedValue,
        direction: loss.direction,
        loss: loss.loss,
      })),
      stake: s.config.stake,
      takeProfit: s.config.dailyProfitTarget,
      stopLoss: s.config.maxDailyLoss,
    };
    const planRequest =
      s.ai.provider === "copilot"
        ? requestCopilotPlan(s.ai.copilotBaseUrl, planInput)
        : requestGroqPlan(this.groqApiKey, s.ai.model, planInput);
    void planRequest
      .then((plan) => {
        const current = this.state;
        this.aiRetryAfter = 0;
        this.lastAiError = "";
        const market = current.markets[plan.symbol];
        const direction: Direction | null = plan.direction === "NONE" ? null : plan.direction;
        const detail = `${plan.symbol} ${plan.direction}, confidence ${(plan.confidence * 100).toFixed(0)}%: ${plan.reason}`;
        this.set({
          ai: {
            ...this.state.ai,
            busy: false,
            lastDecision: detail,
            error: direction ? null : detail,
          },
        });
        if (
          !direction ||
          plan.confidence < 0.5 ||
          !market ||
          !market.lastTickAt ||
          Date.now() - market.lastTickAt > current.config.maxTickAgeMs
        ) {
          this.log("reject", `AUTONOMOUS AI — no eligible trade: ${detail}.`);
          return;
        }
        const safety = this.context(plan.symbol).checks.filter((check) =>
          [
            "conn",
            "auth",
            "latency",
            "fresh",
            "symbol",
            "stake",
            "funds",
            "busy",
            "cooldown",
            "risk",
          ].includes(check.id),
        );
        const failed = safety.find((check) => !check.pass);
        this.set({ checks: safety });
        if (failed) {
          this.log("reject", `AUTONOMOUS AI — ${failed.label}: ${failed.detail}.`);
          return;
        }
        this.log(
          "info",
          `AUTONOMOUS AI selected ${plan.symbol} (${plan.direction}) — ${plan.reason}.`,
        );
        this.set({ active: plan.symbol });
        this.attempt(plan.symbol, direction, market.epochs.at(-1) ?? 0, true);
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : "AI plan failed";
        this.aiRetryAfter = Date.now() + 10000;
        this.set({ ai: { ...this.state.ai, busy: false, error: detail } });
        if (detail !== this.lastAiError) {
          this.lastAiError = detail;
          this.log("reject", `AUTONOMOUS AI — ${detail}.`);
        }
      });
  }

  private selectAccumulatorGrowthRate(m: Market) {
    const configured = this.state.config.accumulatorGrowthRate;
    if (!this.state.config.accumulatorAutoGrowth)
      return m.accumulatorSupported && configured >= 0.01 && configured <= 0.05 ? configured : null;
    // Some contracts_for responses advertise ACCU but omit the rate list.
    // The proposal endpoint still accepts the documented 1%–5% rates, so use
    // the configured rate and let the proposal response remain authoritative.
    return m.accumulatorGrowthRates.length
      ? Math.min(...m.accumulatorGrowthRates)
      : m.accumulatorSupported && configured >= 0.01 && configured <= 0.05
        ? configured
        : null;
  }

  private async attemptAccumulator(sym: string, signal: Direction) {
    const s = this.state;
    const m = s.markets[sym];
    if (!m || s.phase !== "none") return;
    const growthRate = this.selectAccumulatorGrowthRate(m);
    if (growthRate === null) {
      const msg = `[${sym}] ACCUMULATOR REJECTED — no validated growth rate is available.`;
      if (msg !== this.lastReject) {
        this.lastReject = msg;
        this.log("reject", msg);
      }
      return;
    }
    const stake = nextStake(s.config.stake, s.trades);
    const entryChecks = this.context(sym).checks;
    this.set({
      phase: "proposing",
      currentDirection: signal,
      contractMode: "accumulator",
      proposalChecks: [],
    });
    const aiGate = await this.groqGate(sym, signal, m);
    if (!aiGate.pass) {
      this.set({
        phase: "none",
        currentDirection: null,
        contractMode: null,
        proposalChecks: [
          { id: "ai", label: "Groq AI decision", pass: false, detail: aiGate.detail },
        ],
      });
      this.log("reject", `ACCUMULATOR REJECTED — Groq AI: ${aiGate.detail}.`);
      return;
    }
    const req = buildAccumulatorProposalRequest(sym, stake, s.account!.currency, growthRate);
    const res = await this.send(req, 3000);
    const checks = validateAccumulatorProposal(res, { symbol: sym, stake, growthRate });
    this.set({ proposalChecks: checks });
    const failed = checks.find((check) => !check.pass);
    if (failed) {
      if (res.proposal?.id) this.send({ forget: res.proposal.id });
      this.set({ phase: "none", currentDirection: null, contractMode: null });
      this.log("reject", `ACCUMULATOR REJECTED — ${failed.label}: ${failed.detail}.`);
      return;
    }
    this.pendingAccumulatorMeta = {
      symbol: sym,
      direction: signal,
      stake,
      growthRate,
      target: stake * s.config.accumulatorCashOutMultiplier,
      entryChecks,
      startedAt: Date.now(),
    };
    this.set({ phase: "buying" });
    this.log(
      "exec",
      `ACCUMULATOR PROPOSAL ACCEPTED — ${sym}, growth ${(growthRate * 100).toFixed(2)}%, target ${(stake * s.config.accumulatorCashOutMultiplier).toFixed(2)}.`,
    );
    const bought = await this.send({ buy: res.proposal!.id, price: stake }, 10000);
    if (bought.error) {
      if (bought.error.code === "Timeout" || bought.error.message === "Connection closed") {
        this.set({ phase: "reconciling" });
        this.log(
          "error",
          "Accumulator purchase response delayed — reconciling before any new trade.",
        );
        this.reconcile();
        return;
      }
      this.pendingAccumulatorMeta = null;
      this.set({ phase: "none", currentDirection: null, contractMode: null });
      this.log("error", `Accumulator purchase failed: ${bought.error.message}`);
      return;
    }
    this.trackAccumulator(Number(bought.buy.contract_id));
  }

  private async attempt(
    sym: string,
    direction: Direction,
    signalEpoch: number,
    aiAlreadyApproved = false,
  ) {
    const s = this.state;
    const m = s.markets[sym];
    const digit = lastDigit(m.quotes[m.quotes.length - 1], m.pip);
    const entrySnapshot = this.context(sym).checks;
    // EV filter uses actual payout from proposal + historical digit distribution
    const digits = m.quotes.slice(-s.config.sampleSize).map((q) => lastDigit(q, m.pip));
    const dist = digitDistribution(digits);
    const stake = nextStake(s.config.stake, s.trades);
    this.set({
      phase: "proposing",
      currentDirection: direction,
      contractMode: "over-under",
      proposalChecks: [],
    });
    const aiGate = aiAlreadyApproved
      ? { pass: true, detail: "Approved by autonomous Groq plan" }
      : await this.groqGate(sym, direction, m);
    if (!aiGate.pass) {
      this.set({
        phase: "none",
        currentDirection: null,
        contractMode: null,
        proposalChecks: [
          { id: "ai", label: "Groq AI decision", pass: false, detail: aiGate.detail },
        ],
      });
      this.log("reject", `${CONTRACTS[direction].label} REJECTED — Groq AI: ${aiGate.detail}.`);
      return;
    }
    const req = buildProposalRequest(direction, sym, stake, s.account!.currency);
    const proposalSentAt = Date.now();
    const res = await this.send(req, 3000);
    const recvAt = Date.now();
    const pChecks = validateProposal(res, { direction, symbol: sym, stake }, recvAt, Date.now());
    const pWin = direction === "OVER2" ? dist.pOver2 : dist.pUnder7;
    const ev = res.proposal ? expectedValue(pWin, stake, Number(res.proposal.payout)) : -Infinity;
    pChecks.push({
      id: "p_ev",
      label: `Expected value > ${s.config.minEV}`,
      pass: ev > s.config.minEV,
      detail: `EV ${isFinite(ev) ? ev.toFixed(3) : "n/a"} (p=${(pWin * 100).toFixed(1)}%)`,
    });
    // Revalidate everything right before purchase. Fast entry skips only the
    // duplicate signal checks; proposal and account safety checks remain active.
    const again = this.context(sym);
    const cur = this.state.markets[sym];
    pChecks.push({
      id: "p_same_tick",
      label: "Signal tick still latest",
      pass:
        aiAlreadyApproved ||
        s.config.fastEntry ||
        cur?.epochs[cur.epochs.length - 1] === signalEpoch,
      detail: aiAlreadyApproved
        ? "AI plan remains authoritative"
        : s.config.fastEntry
          ? "Skipped in fast-entry mode"
          : "No newer tick",
    });
    const safetyChecks = again.checks.filter((check) =>
      ["conn", "auth", "latency", "fresh", "symbol", "stake", "funds", "risk"].includes(check.id),
    );
    pChecks.push({
      id: "p_revalidate",
      label: "All entry checks and direction re-pass",
      pass:
        aiAlreadyApproved || s.config.fastEntry
          ? safetyChecks.every((check) => check.pass)
          : again.direction === direction && again.checks.every((k) => k.pass || k.id === "busy"),
      detail: aiAlreadyApproved
        ? (safetyChecks.find((check) => !check.pass)?.detail ??
          "AI strategy selected; safety checks passed")
        : s.config.fastEntry
          ? "Skipped in quick-execute mode"
          : again.direction !== direction
            ? "Signal direction changed"
            : (again.checks.find((k) => !k.pass && k.id !== "busy")?.label ?? "OK"),
    });
    pChecks.push({
      id: "p_market",
      label: "Market unchanged",
      pass: this.state.active === sym,
      detail: this.state.active,
    });
    this.set({ proposalChecks: pChecks });
    const failed = pChecks.find((k) => !k.pass);
    if (failed) {
      if (res.proposal?.id) this.send({ forget: res.proposal.id });
      this.lastDecisionMeta = null;
      this.set({ phase: "none", currentDirection: null, contractMode: null });
      this.log(
        failed.id === "p_duration" || failed.id === "p_unit" ? "error" : "reject",
        `${CONTRACTS[direction].label} REJECTED — ${failed.label}: ${failed.detail}.`,
      );
      return;
    }
    this.lastDecisionMeta = {
      signalEpoch,
      analysis: m.analysis,
      confirmation: m.confirm,
      pWin,
      expectedValue: ev,
      latencyMs: s.latencyMs,
      tickAgeMs: m.lastTickAt ? Date.now() - m.lastTickAt : null,
      proposalAgeMs: recvAt - proposalSentAt,
      entryChecks: entrySnapshot,
      proposalChecks: pChecks,
    };
    this.set({ phase: "buying" });
    this.buySentAt = Date.now();
    this.log(
      "exec",
      `TRADE EXECUTED — ${CONTRACTS[direction].label} on ${m.name}, digit ${digit}, stake ${stake}, ${CONTRACT_DURATION}${DURATION_UNIT}. All required checks passed.`,
    );
    const b = await this.send({ buy: res.proposal.id, price: stake }, 10000);
    if (b.error) {
      if (b.error.code === "Timeout" || b.error.message === "Connection closed") {
        this.set({ phase: "reconciling" });
        this.log("error", "Purchase response delayed — reconciling with API before any new trade.");
        this.reconcile();
        return;
      }
      this.lastDecisionMeta = null;
      this.set({ phase: "none", currentDirection: null, contractMode: null });
      this.log("error", `Purchase failed: ${b.error.message}`);
      return;
    }
    this.track(b.buy.contract_id);
  }

  private async groqGate(sym: string, direction: Direction, m: Market) {
    const ai = this.state.ai;
    if (!ai.enabled) return { pass: true, detail: "Disabled" };
    if (!this.groqApiKey) return { pass: false, detail: "API key is not configured" };
    this.set({ ai: { ...ai, busy: true, error: null } });
    try {
      const result = await requestGroqSignal(this.groqApiKey, ai.model, {
        symbol: sym,
        proposedDirection: direction,
        analysis: m.analysis,
        confirmation: m.confirm,
        latestDigits: m.quotes.slice(-20).map((q) => lastDigit(q, m.pip)),
        recentLosses: this.state.lossLogs.slice(0, 10).map((loss) => ({
          cause: loss.cause,
          expectedValue: loss.expectedValue,
          direction: loss.direction,
        })),
      });
      const accepted = result.direction === direction && result.confidence >= 0.5;
      const detail = `${result.direction}, confidence ${(result.confidence * 100).toFixed(0)}%: ${result.reason}`;
      this.set({
        ai: {
          ...this.state.ai,
          busy: false,
          lastDecision: detail,
          error: accepted ? null : detail,
        },
      });
      return { pass: accepted, detail };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Groq request failed";
      this.set({ ai: { ...this.state.ai, busy: false, error: detail } });
      return { pass: false, detail };
    }
  }

  private lastDecisionMeta: DecisionMeta | null = null;
  private pendingAccumulatorMeta: {
    symbol: string;
    direction: Direction;
    stake: number;
    growthRate: number;
    target: number;
    entryChecks: Check[];
    startedAt: number;
  } | null = null;
  private pendingMeta = new Map<
    number,
    DecisionMeta & { direction: Direction; symbol: string; digit: number }
  >();
  private track(contractId: number) {
    const s = this.state;
    const m = s.markets[s.active];
    if (s.currentDirection && m) {
      const entry = this.context(s.active);
      const decision = this.lastDecisionMeta;
      this.pendingMeta.set(contractId, {
        direction: s.currentDirection,
        symbol: s.active,
        digit: lastDigit(m.quotes[m.quotes.length - 1], m.pip),
        signalEpoch: decision?.signalEpoch ?? m.epochs.at(-1) ?? null,
        analysis: decision?.analysis ?? m.analysis,
        confirmation: decision?.confirmation ?? m.confirm,
        pWin: decision?.pWin ?? this.probabilityFor(s.currentDirection, m),
        expectedValue: decision?.expectedValue ?? this.expectedValueFor(s.currentDirection, m),
        latencyMs: decision?.latencyMs ?? s.latencyMs,
        tickAgeMs: decision?.tickAgeMs ?? (m.lastTickAt ? Date.now() - m.lastTickAt : null),
        proposalAgeMs:
          decision?.proposalAgeMs ?? (this.buySentAt ? Date.now() - this.buySentAt : null),
        entryChecks: decision?.entryChecks ?? entry.checks,
        proposalChecks: decision?.proposalChecks ?? s.proposalChecks,
      });
    }
    this.lastDecisionMeta = null;
    this.set({ phase: "open", contractId, contractMode: "over-under" });
    this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }

  private probabilityFor(direction: Direction, m: Market) {
    const d = digitDistribution(
      m.quotes.slice(-this.state.config.sampleSize).map((q) => lastDigit(q, m.pip)),
    );
    return direction === "OVER2" ? d.pOver2 : d.pUnder7;
  }
  private expectedValueFor(direction: Direction, m: Market) {
    return expectedValue(
      this.probabilityFor(direction, m),
      this.state.config.stake,
      this.state.config.stake * 1.33,
    );
  }

  private trackAccumulator(contractId: number) {
    const meta = this.pendingAccumulatorMeta;
    const fallback = {
      growthRate: this.state.config.accumulatorGrowthRate,
      target: this.state.config.stake * this.state.config.accumulatorCashOutMultiplier,
      stake: this.state.config.stake,
    };
    this.set({
      phase: "open",
      contractId,
      contractMode: "accumulator",
      accumulator: {
        ...this.state.accumulator,
        growthRate: meta?.growthRate ?? fallback.growthRate,
        target: meta?.target ?? fallback.target,
        currentValue: meta?.stake ?? fallback.stake,
        peakValue: meta?.stake ?? fallback.stake,
        soldFor: null,
        sellRequested: false,
      },
    });
    this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }

  private createLossLog(c: any, rec: TradeRec, meta: ReturnType<Engine["getLossMeta"]>): LossLog {
    const rawExitValue = c.exit_tick_display_value ?? c.exit_tick ?? c.exit_spot ?? null;
    const exitValue = rawExitValue === null ? null : String(rawExitValue);
    const exitDigit = exitValue === null ? null : Number(exitValue.slice(-1));
    const weak = meta.analysis.difference < 10 || meta.confirmation.difference < 10;
    const poorValue = meta.expectedValue <= 0;
    const executionRisk =
      (meta.latencyMs ?? 0) > this.state.config.maxLatencyMs ||
      (meta.tickAgeMs ?? 0) > this.state.config.maxTickAgeMs;
    const cause: LossCause = executionRisk
      ? "execution-risk"
      : poorValue
        ? "poor-value"
        : weak
          ? "weak-signal"
          : meta.analysis.moves < this.state.config.sampleSize
            ? "insufficient-evidence"
            : "normal-variance";
    const reason =
      cause === "execution-risk"
        ? "Entry was exposed to high latency or stale market data."
        : cause === "poor-value"
          ? "The recorded historical probability did not support positive expected value."
          : cause === "weak-signal"
            ? "The directional edge was narrow at entry."
            : cause === "insufficient-evidence"
              ? "The signal had fewer observations than the configured sample size."
              : "All recorded guards passed; the outcome is currently classified as normal one-tick variance.";
    return {
      id: rec.id,
      time: rec.time,
      symbol: rec.symbol,
      direction: rec.direction,
      entryDigit: rec.entryDigit,
      exitDigit,
      stake: rec.stake,
      payout: rec.payout,
      loss: Math.abs(rec.profit),
      virtual: rec.virtual,
      contractId: rec.contractId,
      cause,
      reason,
      signalEpoch: meta.signalEpoch,
      settledEpoch: c.exit_tick_time ? Number(c.exit_tick_time) : null,
      analysis: meta.analysis,
      confirmation: meta.confirmation,
      pWin: meta.pWin,
      expectedValue: meta.expectedValue,
      latencyMs: meta.latencyMs,
      tickAgeMs: meta.tickAgeMs,
      proposalAgeMs: meta.proposalAgeMs,
      entryChecks: meta.entryChecks,
      proposalChecks: meta.proposalChecks,
      consecutiveLosses: this.state.consecLosses + 1,
      dailyPnl: this.state.day.pnl + rec.profit,
    };
  }
  private getLossMeta(contractId: number) {
    return (
      this.pendingMeta.get(contractId) ?? {
        signalEpoch: null,
        analysis: emptyA,
        confirmation: emptyA,
        pWin: 0,
        expectedValue: 0,
        latencyMs: null,
        tickAgeMs: null,
        proposalAgeMs: null,
        entryChecks: [],
        proposalChecks: [],
      }
    );
  }

  private async reconcile() {
    if (!this.state.connected || !this.state.authorized) return; // will run again on reconnect
    if (this.state.contractId) {
      this.send({ proposal_open_contract: 1, contract_id: this.state.contractId, subscribe: 1 });
      this.set({ phase: "open" });
      return;
    }
    const since = Math.floor(this.buySentAt / 1000) - 5;
    const pf = await this.send({ portfolio: 1 });
    const open = (pf.portfolio?.contracts ?? []).find((c: any) => c.purchase_time >= since);
    if (open) {
      this.log("info", `Reconciled open contract ${open.contract_id}.`);
      if (this.state.contractMode === "accumulator") this.trackAccumulator(open.contract_id);
      else this.track(open.contract_id);
      return;
    }
    const pt = await this.send({ profit_table: 1, limit: 5, description: 1, sort: "DESC" });
    if (pt.error) {
      this.log("error", "Reconciliation failed — trading stays locked.");
      return;
    }
    const done = (pt.profit_table?.transactions ?? []).find((c: any) => c.purchase_time >= since);
    if (done) {
      this.log("info", `Reconciled settled contract ${done.contract_id}.`);
      if (this.state.contractMode === "accumulator") this.trackAccumulator(done.contract_id);
      else this.track(done.contract_id);
      return;
    }
    this.log("info", "Reconciled: no purchase was made.");
    this.pendingAccumulatorMeta = null;
    this.set({ phase: "none", currentDirection: null, contractMode: null });
  }

  private onAccumulatorContract(c: any) {
    if (c.contract_id !== this.state.contractId) return;
    const s = this.state;
    const meta = this.pendingAccumulatorMeta;
    const currentValue = Number(c.bid_price ?? c.sell_price ?? c.contract_value ?? c.payout ?? 0);
    if (!c.is_sold) {
      const current =
        Number.isFinite(currentValue) && currentValue > 0
          ? currentValue
          : s.accumulator.currentValue;
      this.set({
        accumulator: {
          ...s.accumulator,
          currentValue: current,
          peakValue: Math.max(s.accumulator.peakValue ?? 0, current ?? 0),
        },
      });
      const target = s.accumulator.target;
      if (target && current && current >= target && !s.accumulator.sellRequested) {
        this.set({ accumulator: { ...this.state.accumulator, sellRequested: true } });
        this.log(
          "exec",
          `ACCUMULATOR TARGET REACHED — value ${current.toFixed(2)} / target ${target.toFixed(2)}. Requesting sale.`,
        );
        this.send({ sell: c.contract_id, price: current }, 5000).then((result) => {
          if (result.error)
            this.log(
              "error",
              `Accumulator sale response failed: ${result.error.message}. Contract remains under reconciliation.`,
            );
          else
            this.set({
              accumulator: {
                ...this.state.accumulator,
                soldFor: Number(result.sell?.sold_for ?? current),
              },
            });
        });
      }
      return;
    }
    const stake = meta?.stake ?? s.config.stake;
    const soldFor = Number(
      c.sell_price ?? c.sold_for ?? c.bid_price ?? stake + Number(c.profit ?? 0),
    );
    const profit = Number.isFinite(Number(c.profit)) ? Number(c.profit) : soldFor - stake;
    const won = profit > 0;
    const direction = meta?.direction ?? s.currentDirection ?? "OVER2";
    const rec: TradeRec = {
      id: String(c.contract_id),
      time: Date.now(),
      symbol: meta?.symbol ?? s.active,
      direction,
      entryDigit: -1,
      stake,
      payout: soldFor,
      profit,
      won,
      virtual: !!s.account?.isVirtual,
      contractId: c.contract_id,
      strategy: "accumulator",
      growthRate: meta?.growthRate,
      cashOutTarget: meta?.target,
      exitReason: s.accumulator.sellRequested ? "target-cash-out" : "contract-terminated",
    };
    if (s.trades.some((trade) => trade.id === rec.id)) return;
    const cycle = s.cycle
      ? {
          ...s.cycle,
          profit: s.cycle.profit + profit,
          wins: s.cycle.wins + (won ? 1 : 0),
          losses: s.cycle.losses + (won ? 0 : 1),
          tradeIds: [...s.cycle.tradeIds, rec.id],
        }
      : null;
    if (cycle) cycle.peak = Math.max(cycle.peak, cycle.start + cycle.profit);
    const day =
      s.day.date === today()
        ? { ...s.day, pnl: s.day.pnl + profit }
        : { date: today(), pnl: profit };
    const recovered = profit > 0 ? Math.min(s.accumulator.recoveryOutstanding, profit) : 0;
    const recoveryOutstanding = s.config.accumulatorRecoveryMode
      ? Math.max(0, s.accumulator.recoveryOutstanding - recovered) +
        (profit < 0 ? Math.abs(profit) : 0)
      : s.accumulator.recoveryOutstanding;
    const accumulatorMarket = s.markets[meta?.symbol ?? s.active];
    const lossLog: LossLog | null = won
      ? null
      : {
          id: rec.id,
          time: rec.time,
          symbol: rec.symbol,
          direction,
          entryDigit: -1,
          exitDigit: null,
          stake,
          payout: soldFor,
          loss: Math.abs(profit),
          virtual: rec.virtual,
          contractId: rec.contractId,
          cause: s.accumulator.sellRequested ? "normal-variance" : "execution-risk",
          reason: s.accumulator.sellRequested
            ? "The accumulator was sold or settled after the target decision could not preserve the position."
            : "The accumulator terminated before the configured cash-out target was reached.",
          signalEpoch: null,
          settledEpoch: c.exit_tick_time ? Number(c.exit_tick_time) : null,
          analysis: accumulatorMarket?.analysis ?? emptyA,
          confirmation: accumulatorMarket?.confirm ?? emptyA,
          pWin: 0,
          expectedValue: 0,
          latencyMs: s.latencyMs,
          tickAgeMs: accumulatorMarket?.lastTickAt
            ? Date.now() - accumulatorMarket.lastTickAt
            : null,
          proposalAgeMs: meta?.startedAt ? Date.now() - meta.startedAt : null,
          entryChecks: meta?.entryChecks ?? [],
          proposalChecks: s.proposalChecks,
          consecutiveLosses: s.consecLosses + 1,
          dailyPnl: day.pnl,
        };
    this.send({ forget_all: "proposal_open_contract" });
    this.set({
      trades: [rec, ...s.trades],
      lossLogs: lossLog ? [lossLog, ...s.lossLogs].slice(0, 300) : s.lossLogs,
      cycle,
      day,
      learning: this.recordLearning(rec),
      accumulator: {
        ...s.accumulator,
        currentValue: null,
        peakValue: null,
        soldFor,
        sellRequested: false,
        recoveryOutstanding,
        totalRecovered: s.accumulator.totalRecovered + recovered,
      },
      phase: "none",
      contractId: null,
      contractMode: null,
      currentDirection: null,
      marketSwitchPendingLoss: !won,
      ...this.skipStateAfterSettlement(won),
      consecLosses: won ? 0 : s.consecLosses + 1,
      lastSettledAt: Date.now(),
    });
    this.log(
      "settle",
      `ACCUMULATOR SETTLED — ${won ? "PROFIT" : "LOSS"} ${profit.toFixed(2)}; sale ${soldFor.toFixed(2)}; ${rec.exitReason}.`,
    );
    if (this.dailyTargetReached(day.pnl))
      this.halt(`Daily take-profit target reached (${day.pnl.toFixed(2)}).`);
    if (!won)
      this.log(
        "error",
        `ACCUMULATOR LOSS — ${rec.id}: ${rec.exitReason}; recovery outstanding ${recoveryOutstanding.toFixed(2)}.`,
      );
    if (lossLog) this.log("error", `LOSS JOURNAL — ${lossLog.id}: ${lossLog.reason}`);
    this.pendingAccumulatorMeta = null;
    if (cycle && cycleComplete(cycle.start, cycle.profit)) this.completeCycle();
    this.persist();
  }

  private onContract(c: any) {
    if (c.contract_id !== this.state.contractId) return;
    if (this.state.contractMode === "accumulator") {
      this.onAccumulatorContract(c);
      return;
    }
    if (c.tick_count !== undefined && Number(c.tick_count) !== CONTRACT_DURATION)
      this.log(
        "error",
        `ALERT — contract ${c.contract_id} reports ${c.tick_count} ticks (expected 1).`,
      );
    if (!c.is_sold) return;
    const s = this.state;
    const profit = Number(c.profit);
    const won = profit > 0;
    const meta = this.pendingMeta.get(c.contract_id);
    const direction: Direction =
      meta?.direction ?? (c.contract_type === "DIGITOVER" ? "OVER2" : "UNDER7");
    const rec: TradeRec = {
      id: String(c.contract_id),
      time: Date.now(),
      symbol: meta?.symbol ?? c.underlying,
      direction,
      entryDigit: meta?.digit ?? -1,
      stake: Number(c.buy_price),
      payout: Number(c.payout),
      profit,
      won,
      virtual: !!s.account?.isVirtual,
      contractId: c.contract_id,
    };
    if (s.trades.some((t) => t.id === rec.id)) return;
    const cycle = s.cycle
      ? {
          ...s.cycle,
          profit: s.cycle.profit + profit,
          wins: s.cycle.wins + (won ? 1 : 0),
          losses: s.cycle.losses + (won ? 0 : 1),
          tradeIds: [...s.cycle.tradeIds, rec.id],
        }
      : null;
    if (cycle) cycle.peak = Math.max(cycle.peak, cycle.start + cycle.profit);
    const day =
      s.day.date === today()
        ? { ...s.day, pnl: s.day.pnl + profit }
        : { date: today(), pnl: profit };
    this.send({ forget_all: "proposal_open_contract" });
    const lossLog = won ? null : this.createLossLog(c, rec, this.getLossMeta(c.contract_id));
    const learning = this.recordLearning(rec);
    this.set({
      trades: [rec, ...s.trades],
      lossLogs: lossLog ? [lossLog, ...s.lossLogs].slice(0, 300) : s.lossLogs,
      learning,
      cycle,
      day,
      consecLosses: won ? 0 : s.consecLosses + 1,
      phase: "none",
      contractId: null,
      contractMode: null,
      currentDirection: null,
      marketSwitchPendingLoss: !won,
      ...this.skipStateAfterSettlement(won),
      lastSettledAt: Date.now(),
    });
    this.log(
      "settle",
      `SETTLED — ${CONTRACTS[direction].label} ${won ? "WON" : "LOST"} ${profit.toFixed(2)} (exit digit ${
        (c.exit_tick_display_value ?? c.exit_tick ?? c.exit_spot) !== undefined
          ? String(c.exit_tick_display_value ?? c.exit_tick ?? c.exit_spot).slice(-1)
          : "?"
      }).`,
    );
    if (this.dailyTargetReached(day.pnl))
      this.halt(`Daily take-profit target reached (${day.pnl.toFixed(2)}).`);
    if (lossLog)
      this.log("error", `LOSS JOURNAL — ${lossLog.id}: ${lossLog.cause}; ${lossLog.reason}`);
    const learnedKey = this.learningKey(rec.symbol, rec.direction, rec.entryDigit);
    const oldBlock = learningBlock(s.learning.patterns[learnedKey]);
    const newBlock = learningBlock(learning.patterns[learnedKey]);
    if (!oldBlock && newBlock)
      this.log(
        "info",
        `LEARNING UPDATE — ${learnedKey} blocked after enough evidence of poor results. No more trades will use this pattern until history is cleared.`,
      );
    this.pendingMeta.delete(c.contract_id);
    if (cycle && cycleComplete(cycle.start, cycle.profit)) this.completeCycle();
    this.persist();
  }

  private completeCycle() {
    const s = this.state;
    const c = s.cycle!;
    const rec: CycleRec = {
      start: c.start,
      end: c.start + c.profit,
      profit: c.profit,
      wins: c.wins,
      losses: c.losses,
      startedAt: c.startedAt,
      endedAt: Date.now(),
      tradeIds: c.tradeIds,
    };
    this.set({ cycles: [rec, ...s.cycles] });
    this.log("info", `CYCLE COMPLETE — ${rec.start.toFixed(2)} → ${rec.end.toFixed(2)}.`);
    if (s.config.autoRestart && s.status === "running") this.newCycle(rec.end);
    else {
      this.set({ cycle: null });
      this.stop("Cycle target reached (auto-restart off)");
    }
  }
  private newCycle(start: number) {
    this.set({
      cycle: {
        start,
        profit: 0,
        wins: 0,
        losses: 0,
        startedAt: Date.now(),
        tradeIds: [],
        peak: start,
      },
    });
    this.log(
      "info",
      `NEW CYCLE — start ${start.toFixed(2)}, target ${cycleTarget(start).toFixed(2)}, stake ${this.state.config.stake} (unchanged).`,
    );
  }

  // ---------- controls ----------
  start() {
    const s = this.state;
    if (!s.authorized || !s.account) {
      this.log("error", "Connect and authorize a Deriv account first.");
      return;
    }
    if (!s.account.isVirtual && !s.realEnabled) {
      this.log("error", "This is a REAL account. Real trading is not enabled.");
      return;
    }
    if (s.ai.autonomous && !s.account.isVirtual) {
      this.log(
        "error",
        "Autonomous AI mode is demo-only. Select a virtual account before starting.",
      );
      return;
    }
    if (s.ai.autonomous && !s.ai.enabled) {
      this.log("error", "Configure and enable the selected AI provider before autonomous mode.");
      return;
    }
    if (this.dailyTargetReached()) {
      this.halt(`Daily take-profit target already reached (${s.day.pnl.toFixed(2)}).`);
      return;
    }
    if (!s.cycle) this.newCycle(s.account.balance);
    this.set({ status: "running", haltReason: null });
    this.lastReject = "";
    this.log("info", "Bot started.");
  }
  pause() {
    this.set({ status: "paused" });
    this.log("info", "Bot paused. Open trade (if any) will still settle.");
  }
  stop(reason = "Stopped by user") {
    this.set({ status: "stopped", haltReason: reason });
    this.log("info", `Bot stopped — ${reason}.`);
  }
  private halt(reason: string) {
    this.set({ status: "stopped", haltReason: reason });
    this.log("error", `TRADING HALTED — ${reason}.`);
  }
  emergency() {
    this.set({ status: "emergency", haltReason: "Emergency stop" });
    this.send({ forget_all: "proposal" });
    this.log("error", "EMERGENCY STOP — no new trades. Open contract settles on Deriv.");
  }
  resetCycle() {
    if (this.state.phase !== "none") return;
    this.set({ cycle: null, consecLosses: 0 });
    this.log("info", "Cycle tracking reset (account balance untouched).");
  }
  resetLearning() {
    this.set({ learning: { total: 0, wins: 0, losses: 0, patterns: {}, updatedAt: null } });
    this.log("info", "Learned model reset by user; loss journal was kept for review.");
  }

  runBacktest(symbol: string) {
    const m = this.state.markets[symbol];
    if (!m || m.quotes.length < 100) {
      this.log("error", "Not enough history for backtest.");
      return;
    }
    const c = this.state.config;
    // Payouts estimated from the market's real recent proposals are not available offline; use typical Deriv payout ratios.
    const r = backtest(m.quotes, m.pip, {
      sampleSize: c.sampleSize,
      minSample: c.minSample,
      minDifference: c.minDifference,
      stake: c.stake,
      payoutOver2: c.stake * 1.33,
      payoutUnder7: c.stake * 1.33,
      minEV: c.minEV,
    });
    this.set({ backtest: { ...r, symbol }, backtestDone: true });
    this.persist();
    this.log(
      "info",
      `BACKTEST ${symbol} — ${r.trades} trades, ${r.wins}W/${r.losses}L, net ${r.net}. Past results do not guarantee live profit.`,
    );
  }
  clearHistory() {
    this.set({ trades: [], cycles: [], lossLogs: [], logs: [] });
    this.persist();
  }
  tickNow() {
    if (this.state.connected) this.set({ checks: this.context(this.state.active).checks });
  }
}

export const engine = new Engine();
export { DEMO_TRADES_REQUIRED };
