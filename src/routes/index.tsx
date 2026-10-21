import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { engine, DEMO_TRADES_REQUIRED, VOL_SYMBOLS, type State } from "@/lib/bot/engine";
import {
  CONTRACTS,
  CONTRACT_DURATION,
  DURATION_UNIT,
  cycleTarget,
  lastDigit,
  type Check,
} from "@/lib/bot/strategy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Deriv Over/Under Bot — Trading Terminal" },
      {
        name: "description",
        content:
          "Automated Deriv OVER 2 / UNDER 7 bot: fixed stake, 1-tick contracts, strict fail-closed confirmation.",
      },
      { property: "og:title", content: "Deriv Over/Under Bot — Trading Terminal" },
      {
        property: "og:description",
        content: "Fixed stake, 1-tick contracts, every condition confirmed before a trade.",
      },
    ],
  }),
  component: Dashboard,
});

function useEngine(): State {
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
}

function Dashboard() {
  const s = useEngine();
  const [, force] = useState(0);
  useEffect(() => {
    engine.init();
    const t = setInterval(() => {
      engine.tickNow();
      force((x) => x + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const m = s.markets[s.active];
  const digit = m && m.quotes.length ? lastDigit(m.quotes[m.quotes.length - 1], m.pip) : null;
  const wins = s.trades.filter((t) => t.won).length;
  const net = s.trades.reduce((a, t) => a + t.profit, 0);
  const cur = s.account?.currency ?? "";
  const target = s.cycle ? cycleTarget(s.cycle.start) : null;
  const equity = s.cycle ? s.cycle.start + s.cycle.profit : null;

  return (
    <main className="mx-auto max-w-[1500px] p-4 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            OVER 2 / UNDER 7 <span className="text-primary">TERMINAL</span>
          </h1>
          <p className="label-xs">
            No valid signal = no trade · fixed stake · {CONTRACT_DURATION} tick only
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Pill ok={s.connected}>{s.connected ? "API LIVE" : "OFFLINE"}</Pill>
          <Pill ok={s.latencyMs !== null && s.latencyMs <= s.config.maxLatencyMs}>
            {s.latencyMs ?? "–"} ms
          </Pill>
          {s.account && (
            <Pill ok={s.account.isVirtual} warn={!s.account.isVirtual}>
              {s.account.isVirtual ? "DEMO" : "REAL"} · {s.account.loginid}
            </Pill>
          )}
          <Pill ok={s.status === "running"} warn={s.status === "paused"}>
            {s.status.toUpperCase()}
          </Pill>
        </div>
      </header>

      {s.haltReason && s.status !== "running" && (
        <div className="panel border-danger p-3 text-sm text-danger">HALTED — {s.haltReason}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr_380px]">
        <Controls s={s} />

        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat l="Balance" v={s.account ? `${s.account.balance.toFixed(2)} ${cur}` : "–"} />
            <Stat l="Fixed stake" v={`${s.config.stake.toFixed(2)}`} />
            <Stat l="Cycle start" v={s.cycle ? s.cycle.start.toFixed(2) : "–"} />
            <Stat
              l="Cycle P/L"
              v={s.cycle ? s.cycle.profit.toFixed(2) : "–"}
              tone={s.cycle ? (s.cycle.profit >= 0 ? "up" : "down") : undefined}
            />
            <Stat l="Triple target" v={target ? target.toFixed(2) : "–"} />
            <Stat
              l="To target"
              v={target && equity !== null ? Math.max(0, target - equity).toFixed(2) : "–"}
            />
            <Stat l="Today P/L" v={s.day.pnl.toFixed(2)} tone={s.day.pnl >= 0 ? "up" : "down"} />
            <Stat l="Consec. losses" v={`${s.consecLosses} / ${s.config.maxConsecLosses}`} />
          </div>

          <div className="panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold">{m?.name ?? s.active}</h2>
              <span className="label-xs">
                Active market · {s.config.autoSwitch ? "auto switching" : "manual"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 md:grid-cols-6">
              <Stat l="Bullish" v={m ? `${m.analysis.bullish}` : "–"} tone="up" />
              <Stat l="Bearish" v={m ? `${m.analysis.bearish}` : "–"} tone="down" />
              <Stat
                l="Difference"
                v={m ? `${m.analysis.difference}` : "–"}
                tone={m && m.analysis.difference >= 5 ? "up" : "down"}
              />
              <Stat
                l="Latest tick"
                v={m?.quotes.length ? m.quotes[m.quotes.length - 1].toFixed(m.pip) : "–"}
              />
              <Stat l="Last digit" v={digit ?? "–"} big />
              <Stat
                l="Signal"
                v={m?.analysis.direction ? CONTRACTS[m.analysis.direction].label : "NONE"}
                tone={m?.analysis.direction ? "up" : undefined}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Score = % of up vs down moves over last {s.config.sampleSize} ticks. Qualifies at
              difference ≥ 5. Status: <b className="text-foreground">{m?.reject ?? "–"}</b>
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <ChecksPanel title="Entry conditions" checks={s.checks} />
            <ChecksPanel
              title={`Proposal validation · ${s.phase.toUpperCase()}`}
              checks={s.proposalChecks}
              empty="Runs when a signal fires"
            />
          </div>

          <Markets s={s} />
          <Performance s={s} />
          <LossJournal s={s} />
        </section>

        <section className="space-y-4">
          <div className="panel p-4 grid grid-cols-2 gap-3">
            <Stat l="Contract" v={s.currentDirection ? CONTRACTS[s.currentDirection].label : "–"} />
            <Stat l="Trade status" v={s.phase.toUpperCase()} />
            <Stat l="Total trades" v={s.trades.length} />
            <Stat
              l="Win rate"
              v={s.trades.length ? `${((wins / s.trades.length) * 100).toFixed(1)}%` : "–"}
            />
            <Stat l="Wins / Losses" v={`${wins} / ${s.trades.length - wins}`} />
            <Stat
              l="Loss journals"
              v={s.lossLogs.length}
              tone={s.lossLogs.length ? "down" : undefined}
            />
            <Stat l="Net P/L" v={net.toFixed(2)} tone={net >= 0 ? "up" : "down"} />
          </div>
          <LogPanel s={s} />
        </section>
      </div>
    </main>
  );
}

function Controls({ s }: { s: State }) {
  const [token, setToken] = useState("");
  const [confirm, setConfirm] = useState("");
  const c = s.config;
  const busy = s.phase !== "none";
  const num = (k: keyof typeof c) => (e: React.ChangeEvent<HTMLInputElement>) =>
    engine.updateConfig({ [k]: Number(e.target.value) } as never);
  return (
    <aside className="space-y-4">
      <div className="panel p-4 space-y-2">
        <h3 className="label-xs">Deriv account</h3>
        <Input
          type="password"
          placeholder="API token (demo or real)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Field l="App ID">
          <Input
            placeholder="From developers.deriv.com"
            value={c.appId}
            onChange={(e) => engine.updateConfig({ appId: e.target.value })}
          />
        </Field>
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => {
              engine.connect(token);
              setToken("");
            }}
            disabled={!token}
          >
            Connect
          </Button>
          <Button variant="secondary" onClick={() => engine.disconnect()}>
            Disconnect
          </Button>
        </div>
        {s.accounts.length > 0 && (
          <Field l="Account">
            <select
              className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
              value={s.selectedAccount ?? ""}
              onChange={(e) => engine.selectAccount(e.target.value)}
            >
              {s.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.isVirtual ? "DEMO" : "REAL"} · {a.id}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="text-[11px] text-muted-foreground">
          For pat_ tokens, the App ID must be from an app you registered at developers.deriv.com.
          The token is kept in memory only. Demo is chosen by default.
        </p>
      </div>

      <div className="panel p-4 grid grid-cols-2 gap-2">
        <Button onClick={() => engine.start()} disabled={s.status === "running"}>
          Start
        </Button>
        <Button variant="secondary" onClick={() => engine.pause()}>
          Pause
        </Button>
        <Button variant="secondary" onClick={() => engine.stop()}>
          Stop
        </Button>
        <Button variant="destructive" onClick={() => engine.emergency()}>
          Emergency
        </Button>
        <Button
          variant="outline"
          className="col-span-2"
          onClick={() => engine.resetCycle()}
          disabled={busy}
        >
          Reset cycle tracking
        </Button>
      </div>

      <div className="panel p-4 space-y-2">
        <h3 className="label-xs">Strategy & risk</h3>
        <Field l="Trading strategy">
          <select
            className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
            value={c.tradeMode}
            disabled={busy || s.status === "running"}
            onChange={(e) =>
              engine.updateConfig({ tradeMode: e.target.value as typeof c.tradeMode })
            }
          >
            <option value="auto-over-under">Auto OVER 2 / UNDER 7</option>
            <option value="over-only">OVER 2 only</option>
            <option value="under-only">UNDER 7 only</option>
            <option value="accumulator">Accumulator (module validation)</option>
          </select>
        </Field>
        <Field l="Min bull/bear difference">
          <Input
            type="number"
            step="0.5"
            min="0"
            max="100"
            defaultValue={c.minDifference}
            onBlur={num("minDifference")}
          />
        </Field>
        {c.tradeMode === "accumulator" && (
          <div className="rounded border border-warning p-2 text-xs text-warning">
            Accumulator settings are saved, but accumulator orders are blocked until the proposal
            and cash-out lifecycle is fully validated. No OVER/UNDER order will be sent in this
            mode.
          </div>
        )}
        <Field l="Fixed stake">
          <Input
            type="number"
            step="0.01"
            min="0.35"
            defaultValue={c.stake}
            disabled={busy || s.status === "running"}
            onBlur={num("stake")}
          />
        </Field>
        <Field l="Duration">
          <div className="text-sm text-primary">
            {CONTRACT_DURATION} tick ({DURATION_UNIT}) · locked
          </div>
        </Field>
        <Field l="Max daily loss">
          <Input type="number" defaultValue={c.maxDailyLoss} onBlur={num("maxDailyLoss")} />
        </Field>
        <Field l="Max drawdown">
          <Input type="number" defaultValue={c.maxDrawdown} onBlur={num("maxDrawdown")} />
        </Field>
        <Field l="Max consec. losses">
          <Input type="number" defaultValue={c.maxConsecLosses} onBlur={num("maxConsecLosses")} />
        </Field>
        <Field l="Sample size">
          <Input type="number" defaultValue={c.sampleSize} onBlur={num("sampleSize")} />
        </Field>
        <Field l="Min sample">
          <Input type="number" defaultValue={c.minSample} onBlur={num("minSample")} />
        </Field>
        <Field l="Cooldown (s)">
          <Input type="number" defaultValue={c.cooldownSec} onBlur={num("cooldownSec")} />
        </Field>
        <Field l="Min EV">
          <Input type="number" step="0.01" defaultValue={c.minEV} onBlur={num("minEV")} />
        </Field>
        {c.tradeMode === "accumulator" && (
          <>
            <Field l="Accumulator growth">
              <Input
                type="number"
                step="0.01"
                min="0.01"
                defaultValue={c.accumulatorGrowthRate}
                onBlur={num("accumulatorGrowthRate")}
              />
            </Field>
            <Field l="Cash-out multiplier">
              <Input
                type="number"
                step="0.25"
                min="1.25"
                defaultValue={c.accumulatorCashOutMultiplier}
                onBlur={num("accumulatorCashOutMultiplier")}
              />
            </Field>
            <Field l="Auto growth selection">
              <Switch
                checked={c.accumulatorAutoGrowth}
                onCheckedChange={(v) => engine.updateConfig({ accumulatorAutoGrowth: v })}
              />
            </Field>
            <Field l="Recovery ledger">
              <Switch
                checked={c.accumulatorRecoveryMode}
                onCheckedChange={(v) => engine.updateConfig({ accumulatorRecoveryMode: v })}
              />
            </Field>
          </>
        )}
        <Field l="Max tick age ms">
          <Input type="number" defaultValue={c.maxTickAgeMs} onBlur={num("maxTickAgeMs")} />
        </Field>
        <Field l="Max latency ms">
          <Input type="number" defaultValue={c.maxLatencyMs} onBlur={num("maxLatencyMs")} />
        </Field>
        <Field l="Auto market switch">
          <Switch
            checked={c.autoSwitch}
            onCheckedChange={(v) => engine.updateConfig({ autoSwitch: v })}
          />
        </Field>
        {!c.autoSwitch && (
          <Field l="Market">
            <select
              className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
              value={c.manualSymbol}
              onChange={(e) => engine.updateConfig({ manualSymbol: e.target.value })}
            >
              {VOL_SYMBOLS.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
        )}
        <Field l="Auto cycle restart">
          <Switch
            checked={c.autoRestart}
            onCheckedChange={(v) => engine.updateConfig({ autoRestart: v })}
          />
        </Field>
      </div>

      <div className="panel p-4 space-y-2">
        <h3 className="label-xs">Validation & real money</h3>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => engine.runBacktest(s.active)}
          disabled={!s.markets[s.active]}
        >
          Backtest {s.active} history
        </Button>
        {s.backtest && (
          <p className="text-xs">
            {s.backtest.symbol}: {s.backtest.trades} trades · {s.backtest.wins}W/{s.backtest.losses}
            L · net {s.backtest.net}. Not a guarantee of live results.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Demo trades settled: {engine.demoTradesSettled()} / {DEMO_TRADES_REQUIRED} · Backtest:{" "}
          {s.backtestDone ? "done" : "pending"}
        </p>
        <Button variant="outline" className="w-full" onClick={() => engine.resetLearning()}>
          Reset learned model
        </Button>
        {s.realEnabled ? (
          <Button variant="destructive" className="w-full" onClick={() => engine.disableReal()}>
            Real trading ENABLED — disable
          </Button>
        ) : (
          <>
            <Input
              placeholder='Type "ENABLE REAL"'
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={!engine.canEnableReal()}
            />
            <Button
              variant="secondary"
              className="w-full"
              disabled={!engine.canEnableReal()}
              onClick={() => {
                engine.enableReal(confirm);
                setConfirm("");
              }}
            >
              Enable real trading
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}

function Markets({ s }: { s: State }) {
  const list = Object.values(s.markets);
  return (
    <div className="panel p-4">
      <h3 className="label-xs mb-2">Market scanner</h3>
      {!list.length ? (
        <p className="text-sm text-muted-foreground">Connect to stream volatility markets.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th>Market</th>
              <th>Bull</th>
              <th>Bear</th>
              <th>Diff</th>
              <th>Digit</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr
                key={m.symbol}
                className={cn("border-t border-border", m.symbol === s.active && "text-primary")}
              >
                <td className="py-1">{m.symbol}</td>
                <td>{m.analysis.bullish}</td>
                <td>{m.analysis.bearish}</td>
                <td className={m.analysis.difference >= 5 ? "text-success" : "text-danger"}>
                  {m.analysis.difference}
                </td>
                <td>{m.quotes.length ? lastDigit(m.quotes[m.quotes.length - 1], m.pip) : "–"}</td>
                <td>{m.reject}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Performance({ s }: { s: State }) {
  const group = (key: (t: State["trades"][number]) => string) => {
    const g: Record<string, { n: number; w: number; p: number }> = {};
    s.trades.forEach((t) => {
      const k = key(t);
      g[k] ??= { n: 0, w: 0, p: 0 };
      g[k].n++;
      if (t.won) g[k].w++;
      g[k].p += t.profit;
    });
    return Object.entries(g);
  };
  const sections = [
    ["By market", group((t) => t.symbol)],
    ["By entry digit", group((t) => String(t.entryDigit))],
    ["By direction", group((t) => CONTRACTS[t.direction].label)],
  ] as const;
  return (
    <div className="panel p-4">
      <h3 className="label-xs mb-2">Performance</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Learning: {s.learning.total} settled · {Object.keys(s.learning.patterns).length} patterns
        tracked · adapts only after 30 observations with a conservative confidence bound.
      </p>
      <div className="grid gap-4 md:grid-cols-3 text-xs">
        {sections.map(([title, rows]) => (
          <div key={title}>
            <div className="text-muted-foreground mb-1">{title}</div>
            {!rows.length && <div className="text-muted-foreground">No trades yet</div>}
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span>{k}</span>
                <span>
                  {v.n} · {((v.w / v.n) * 100).toFixed(0)}% ·{" "}
                  <span className={v.p >= 0 ? "text-success" : "text-danger"}>
                    {v.p.toFixed(2)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {s.cycles.length > 0 && (
        <div className="mt-3 text-xs">
          <div className="text-muted-foreground">Completed cycles</div>
          {s.cycles.slice(0, 5).map((c) => (
            <div key={c.endedAt}>
              {c.start.toFixed(2)} → {c.end.toFixed(2)} · {c.wins}W/{c.losses}L
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LossJournal({ s }: { s: State }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="label-xs">Loss journal</h3>
          <p className="text-xs text-muted-foreground">
            Structured evidence captured at every losing settlement.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{s.lossLogs.length} recorded</span>
      </div>
      {!s.lossLogs.length ? (
        <p className="text-xs text-muted-foreground">No losses recorded yet.</p>
      ) : (
        <div className="space-y-2 text-xs">
          {s.lossLogs.slice(0, 10).map((l) => (
            <details key={l.id} className="rounded border border-border p-2">
              <summary className="cursor-pointer flex flex-wrap justify-between gap-2">
                <span>
                  <b className="text-danger">LOSS</b> {l.symbol} · {CONTRACTS[l.direction].label} ·
                  entry {l.entryDigit} → exit {l.exitDigit ?? "?"}
                </span>
                <span className="text-muted-foreground">
                  {new Date(l.time).toLocaleString()} · {l.cause}
                </span>
              </summary>
              <div className="mt-2 grid gap-1 md:grid-cols-3 text-muted-foreground">
                <span>
                  Loss: <b className="text-danger">{l.loss.toFixed(2)}</b> · stake{" "}
                  {l.stake.toFixed(2)}
                </span>
                <span>
                  Edge: {l.analysis.difference} · confirm {l.confirmation.difference}
                </span>
                <span>
                  p(win): {(l.pWin * 100).toFixed(1)}% · EV: {l.expectedValue.toFixed(3)}
                </span>
                <span>
                  Latency: {l.latencyMs ?? "?"} ms · tick age: {l.tickAgeMs ?? "?"} ms
                </span>
                <span>
                  Daily P/L: {l.dailyPnl.toFixed(2)} · consecutive: {l.consecutiveLosses}
                </span>
                <span>
                  Signal epoch: {l.signalEpoch ?? "?"} · settled: {l.settledEpoch ?? "?"}
                </span>
              </div>
              <p className="mt-2 text-muted-foreground">Diagnosis: {l.reason}</p>
              <div className="mt-2 grid gap-1 md:grid-cols-2">
                <CheckSummary title="Entry checks" checks={l.entryChecks} />
                <CheckSummary title="Proposal checks" checks={l.proposalChecks} />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function CheckSummary({ title, checks }: { title: string; checks: Check[] }) {
  return (
    <div>
      <div className="text-muted-foreground">
        {title}: {checks.filter((c) => c.pass).length}/{checks.length} passed
      </div>
      <div className="truncate">
        {checks
          .filter((c) => !c.pass)
          .map((c) => c.label)
          .join(", ") || "All checks passed"}
      </div>
    </div>
  );
}

function LogPanel({ s }: { s: State }) {
  const tone = {
    accept: "text-success",
    exec: "text-success",
    settle: "text-foreground",
    reject: "text-muted-foreground",
    switch: "text-warning",
    error: "text-danger",
    info: "text-foreground",
  };
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="label-xs">Activity log</h3>
        <button className="label-xs hover:text-foreground" onClick={() => engine.clearHistory()}>
          Clear history
        </button>
      </div>
      <div className="h-[640px] overflow-auto space-y-1 text-[11px]">
        {s.logs.map((l, i) => (
          <div key={i} className={tone[l.kind]}>
            <span className="text-muted-foreground">{new Date(l.t).toLocaleTimeString()} </span>
            {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChecksPanel({
  title,
  checks,
  empty = "Connect to evaluate",
}: {
  title: string;
  checks: Check[];
  empty?: string;
}) {
  return (
    <div className="panel p-4">
      <h3 className="label-xs mb-2">{title}</h3>
      {!checks.length && <p className="text-xs text-muted-foreground">{empty}</p>}
      <ul className="space-y-1 text-xs">
        {checks.map((c) => (
          <li key={c.id} className="flex justify-between gap-2">
            <span>
              <b className={c.pass ? "text-success" : "text-danger"}>{c.pass ? "PASS" : "FAIL"}</b>{" "}
              {c.label}
            </span>
            <span className="text-muted-foreground truncate">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({
  l,
  v,
  tone,
  big,
}: {
  l: string;
  v: React.ReactNode;
  tone?: "up" | "down";
  big?: boolean;
}) {
  return (
    <div className="panel bg-muted/40 p-2">
      <div className="label-xs">{l}</div>
      <div
        className={cn(
          "font-semibold",
          big ? "text-3xl" : "text-base",
          tone === "up" && "text-success",
          tone === "down" && "text-danger",
        )}
      >
        {v}
      </div>
    </div>
  );
}
function Field({ l, children }: { l: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[1fr_1.2fr] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{l}</span>
      {children}
    </label>
  );
}
function Pill({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-2 py-1",
        warn
          ? "border-warning text-warning"
          : ok
            ? "border-success text-success"
            : "border-danger text-danger",
      )}
    >
      {children}
    </span>
  );
}
