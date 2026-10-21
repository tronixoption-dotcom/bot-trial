import { describe, expect, it } from "vitest";
import {
  analyze,
  backtest,
  buildAccumulatorProposalRequest,
  buildProposalRequest,
  cycleComplete,
  cycleTarget,
  entryDigitOk,
  evaluateEntry,
  expectedValue,
  lastDigit,
  learningBlock,
  nextStake,
  rankMarkets,
  riskBlock,
  validateProposal,
  validateAccumulatorProposal,
  type EntryContext,
} from "./strategy";

const up = (n: number, start = 100) => Array.from({ length: n + 1 }, (_, i) => start + i);
const mixed = (ups: number, downs: number) => {
  const q = [100];
  for (let i = 0; i < ups; i++) q.push(q[q.length - 1] + 1);
  for (let i = 0; i < downs; i++) q.push(q[q.length - 1] - 1);
  return q;
};

describe("entry digits", () => {
  it("OVER 2 only on digits 0 and 1", () => {
    for (let d = 0; d <= 9; d++) expect(entryDigitOk("OVER2", d)).toBe(d === 0 || d === 1);
  });
  it("UNDER 7 only on digits 8 and 9", () => {
    for (let d = 0; d <= 9; d++) expect(entryDigitOk("UNDER7", d)).toBe(d === 8 || d === 9);
  });
  it("last digit uses quoted precision (trailing zero kept)", () => {
    expect(lastDigit(1234.5, 2)).toBe(0);
    expect(lastDigit(1234.57, 2)).toBe(7);
    expect(lastDigit(6543.21, 3)).toBe(0);
  });
});

describe("bullish/bearish difference", () => {
  it("difference 4 does not qualify", () => {
    const a = analyze(mixed(52, 48), 100, 30); // 52 - 48 = 4
    expect(a.difference).toBe(4);
    expect(a.qualifies).toBe(false);
    expect(a.direction).toBeNull();
  });
  it("difference 5 qualifies bullish -> OVER 2", () => {
    const q = mixed(50, 45);
    q.push(...Array(5).fill(q[q.length - 1])); // 50 up, 45 down, 5 flat -> 100 moves
    const a = analyze(q, 100, 30);
    expect(a.difference).toBe(5);
    expect(a.direction).toBe("OVER2");
  });
  it("bearish advantage -> UNDER 7", () => {
    expect(analyze(mixed(40, 60), 100, 30).direction).toBe("UNDER7");
  });
  it("equal scores never trade", () => {
    expect(analyze(mixed(50, 50), 100, 30).qualifies).toBe(false);
  });
  it("insufficient sample = no trade", () => {
    const a = analyze(up(10), 50, 30);
    expect(a.sufficient).toBe(false);
    expect(a.qualifies).toBe(false);
  });
});

const goodCtx = (o: Partial<EntryContext> = {}): EntryContext => {
  const a = analyze(up(50), 50, 30);
  return {
    connected: true,
    authorized: true,
    latencyMs: 100,
    maxLatencyMs: 1500,
    tickAgeMs: 500,
    maxTickAgeMs: 4000,
    symbolSupported: true,
    analysis: a,
    confirmAnalysis: a,
    latestDigit: 1,
    stake: 1,
    fixedStake: 1,
    balance: 100,
    busy: false,
    riskBlock: null,
    cooldownRemainingMs: 0,
    realAccountBlocked: false,
    ...o,
  };
};

describe("strict confirmation engine", () => {
  it("passes only when every condition holds", () => {
    expect(evaluateEntry(goodCtx()).direction).toBe("OVER2");
  });
  it.each([
    ["disconnected", { connected: false }],
    ["unauthorized", { authorized: false }],
    ["stale tick", { tickAgeMs: 9000 }],
    ["no tick", { tickAgeMs: null }],
    ["high latency", { latencyMs: 3000 }],
    ["wrong digit", { latestDigit: 5 }],
    ["busy (duplicate purchase)", { busy: true }],
    ["risk block", { riskBlock: "x" }],
    ["cooldown", { cooldownRemainingMs: 1000 }],
    ["stake mismatch", { stake: 2 }],
    ["no funds", { balance: 0.5 }],
    ["real not enabled", { realAccountBlocked: true }],
    ["unsupported market", { symbolSupported: false }],
  ] as const)("rejects when %s", (_n, o) => {
    expect(evaluateEntry(goodCtx(o as Partial<EntryContext>)).direction).toBeNull();
  });
  it("rejects when confirmation disagrees", () => {
    expect(
      evaluateEntry(goodCtx({ confirmAnalysis: analyze(mixed(10, 50), 50, 30) })).direction,
    ).toBeNull();
  });
  it("allows confirmation to be disabled explicitly", () => {
    expect(
      evaluateEntry(
        goodCtx({ confirmAnalysis: analyze(mixed(10, 50), 50, 30), requireConfirmation: false }),
      ).direction,
    ).toBe("OVER2");
  });
  it("accepts a doubled stake only when double-after-loss is enabled", () => {
    expect(evaluateEntry(goodCtx({ stake: 2, doubleAfterLoss: true })).direction).toBe("OVER2");
    expect(evaluateEntry(goodCtx({ stake: 2 })).direction).toBeNull();
  });
});

describe("bounded learning guard", () => {
  it("does not react to a small sample", () => {
    expect(learningBlock({ trades: 29, wins: 0, losses: 29, profit: -29 })).toBeNull();
  });
  it("blocks a repeatedly poor pattern after enough evidence", () => {
    expect(learningBlock({ trades: 30, wins: 5, losses: 25, profit: -20 })).toMatch(
      /Learned guard/,
    );
  });
  it("keeps a strong pattern eligible", () => {
    expect(learningBlock({ trades: 30, wins: 24, losses: 6, profit: 10 })).toBeNull();
  });
});

describe("1-tick contract duration", () => {
  const ok = {
    echo_req: { ...buildProposalRequest("OVER2", "R_100", 1, "USD") },
    proposal: { id: "p1", ask_price: 1, payout: 1.33 },
  };
  it("request is always 1 tick", () => {
    const r = buildProposalRequest("UNDER7", "R_10", 1, "USD");
    expect(r.duration).toBe(1);
    expect(r.duration_unit).toBe("t");
    expect(r.contract_type).toBe("DIGITUNDER");
    expect(r.barrier).toBe("7");
  });
  it("accepts a valid 1-tick proposal", () => {
    expect(
      validateProposal(ok, { direction: "OVER2", symbol: "R_100", stake: 1 }, 0, 100).every(
        (c) => c.pass,
      ),
    ).toBe(true);
  });
  it.each([
    [2, "t"],
    [5, "t"],
    [1, "s"],
    [1, "m"],
  ])("rejects duration %s%s", (d, u) => {
    const bad = { ...ok, echo_req: { ...ok.echo_req, duration: d, duration_unit: u } };
    expect(
      validateProposal(bad, { direction: "OVER2", symbol: "R_100", stake: 1 }, 0, 100).every(
        (c) => c.pass,
      ),
    ).toBe(false);
  });
  it("rejects expired proposal", () => {
    expect(
      validateProposal(ok, { direction: "OVER2", symbol: "R_100", stake: 1 }, 0, 5000).find(
        (c) => c.id === "p_fresh",
      )!.pass,
    ).toBe(false);
  });
  it("rejects wrong barrier", () => {
    const bad = { ...ok, echo_req: { ...ok.echo_req, barrier: "3" } };
    expect(
      validateProposal(bad, { direction: "OVER2", symbol: "R_100", stake: 1 }, 0, 100).every(
        (c) => c.pass,
      ),
    ).toBe(false);
  });
});

describe("accumulator proposal safety", () => {
  it("builds an ACCU proposal with the fixed stake and growth rate", () => {
    const request = buildAccumulatorProposalRequest("R_100", 1, "USD", 0.03);
    expect(request.contract_type).toBe("ACCU");
    expect(request.growth_rate).toBe(0.03);
    expect(request.amount).toBe(1);
  });
  it("rejects an accumulator proposal with a mismatched growth rate", () => {
    const checks = validateAccumulatorProposal(
      {
        echo_req: {
          contract_type: "ACCU",
          underlying_symbol: "R_100",
          amount: 1,
          basis: "stake",
          growth_rate: 0.05,
        },
        proposal: { id: "a", ask_price: 1 },
      },
      { symbol: "R_100", stake: 1, growthRate: 0.03 },
    );
    expect(checks.find((check) => check.id === "a_growth")?.pass).toBe(false);
  });
});

describe("fixed stake, risk and cycles", () => {
  it("stake stays fixed after consecutive losses", () => {
    expect(nextStake(1, Array(10).fill({ profit: -1 }))).toBe(1);
  });
  it("uses twice the base stake after losses without compounding", () => {
    expect(nextStake(1, [{ profit: -1 }], true)).toBe(2);
    expect(nextStake(1, Array(3).fill({ profit: -1 }), true)).toBe(2);
    expect(nextStake(1, [{ profit: 0.33 }], true)).toBe(1);
    expect(nextStake(1, [], true)).toBe(1);
  });
  it("risk limits", () => {
    const cfg = { maxDailyLoss: 10, maxDrawdown: 8, maxConsecLosses: 3 };
    expect(riskBlock({ dailyPnl: -10, peakEquity: 0, equity: 0, consecLosses: 0 }, cfg)).toMatch(
      /daily/,
    );
    expect(riskBlock({ dailyPnl: 0, peakEquity: 20, equity: 12, consecLosses: 0 }, cfg)).toMatch(
      /drawdown/,
    );
    expect(riskBlock({ dailyPnl: 0, peakEquity: 0, equity: 0, consecLosses: 3 }, cfg)).toMatch(
      /consecutive/,
    );
    expect(riskBlock({ dailyPnl: -9, peakEquity: 10, equity: 3, consecLosses: 2 }, cfg)).toBeNull();
  });
  it("triple cycle: $10 start completes at $30", () => {
    expect(cycleTarget(10)).toBe(30);
    expect(cycleComplete(10, 19.99)).toBe(false);
    expect(cycleComplete(10, 20)).toBe(true);
  });
  it("EV", () => {
    expect(expectedValue(0.7, 1, 1.33)).toBeCloseTo(0.7 * 0.33 - 0.3);
  });
});

describe("market switching", () => {
  it("picks strongest fresh, confirmed qualifying market", () => {
    const a = (u: number, d: number) => analyze(mixed(u, d), 100, 30);
    const r = rankMarkets([
      { symbol: "R_10", analysis: a(55, 45), fresh: true, confirmed: true },
      { symbol: "R_25", analysis: a(70, 30), fresh: false, confirmed: true },
      { symbol: "R_50", analysis: a(65, 35), fresh: true, confirmed: true },
      { symbol: "R_75", analysis: a(51, 49), fresh: true, confirmed: true },
    ]);
    expect(r.map((m) => m.symbol)).toEqual(["R_50", "R_10"]);
  });
});

describe("backtest", () => {
  it("runs one trade at a time and never trades flat data", () => {
    expect(
      backtest(Array(300).fill(100), 2, {
        sampleSize: 50,
        minSample: 30,
        stake: 1,
        payoutOver2: 1.33,
        payoutUnder7: 1.33,
        minEV: 0,
      }).trades,
    ).toBe(0);
  });
});

describe("proposal contract text", () => {
  it("rejects a proposal whose contract text says 2 ticks", () => {
    const res = {
      echo_req: { ...buildProposalRequest("OVER2", "R_100", 1, "USD") },
      proposal: {
        id: "p",
        ask_price: 1,
        payout: 1.4,
        longcode:
          "Win payout if the last digit of Volatility 100 Index is strictly higher than 2 after 2 ticks.",
      },
    };
    expect(
      validateProposal(res, { direction: "OVER2", symbol: "R_100", stake: 1 }, 0, 10).find(
        (c) => c.id === "p_longcode",
      )!.pass,
    ).toBe(false);
  });
});
