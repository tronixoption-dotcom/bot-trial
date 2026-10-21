export type GroqDirection = "OVER2" | "UNDER7" | "NONE";

export interface GroqSignalInput {
  symbol: string;
  proposedDirection: Exclude<GroqDirection, "NONE">;
  analysis: { bullish: number; bearish: number; difference: number; moves: number };
  confirmation: { bullish: number; bearish: number; difference: number; moves: number };
  latestDigits: number[];
  recentLosses: Array<{ cause: string; expectedValue: number; direction: string }>;
}

export interface GroqSignal {
  direction: GroqDirection;
  confidence: number;
  reason: string;
}

export interface GroqAutonomousInput {
  markets: Array<{
    symbol: string;
    bullish: number;
    bearish: number;
    difference: number;
    direction: string | null;
    moves: number;
    fresh: boolean;
    latestDigits: number[];
  }>;
  recentLosses: Array<{
    symbol: string;
    cause: string;
    expectedValue: number;
    direction: string;
    loss: number;
  }>;
  stake: number;
  takeProfit: number;
  stopLoss: number;
}

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export async function requestGroqSignal(
  apiKey: string,
  model: string,
  input: GroqSignalInput,
): Promise<GroqSignal> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 160,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You are a conservative trading risk reviewer. Return JSON only: {"direction":"OVER2"|"UNDER7"|"NONE","confidence":0..1,"reason":"short explanation"}. You must choose NONE when the evidence is weak, conflicting, or does not support the proposed direction. Never invent data and never recommend increasing stake.',
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Groq request failed (${response.status})`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Groq returned no decision");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "").trim());
  } catch {
    throw new Error("Groq returned invalid decision JSON");
  }
  const value = parsed as Partial<GroqSignal>;
  const direction = value.direction;
  const confidence = Number(value.confidence);
  if (!direction || !["OVER2", "UNDER7", "NONE"].includes(direction))
    throw new Error("Groq returned an invalid direction");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error("Groq returned an invalid confidence");
  return {
    direction,
    confidence,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 240) : "No reason supplied",
  };
}

export async function requestGroqPlan(
  apiKey: string,
  model: string,
  input: GroqAutonomousInput,
): Promise<{ symbol: string; direction: GroqDirection; confidence: number; reason: string }> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 220,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You are a conservative demo-only trading planner. Return JSON only: {"symbol":"exact supplied symbol","direction":"OVER2"|"UNDER7"|"NONE","confidence":0..1,"reason":"short explanation"}. Select only a fresh supplied market. Choose NONE when evidence is weak or conflicting. Do not increase stake, invent markets, or promise profit. This is a proposal, not permission to bypass platform safety checks.',
        },
        { role: "user", content: JSON.stringify(input) },
      ],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(payload?.error?.message ?? `Groq request failed (${response.status})`);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Groq returned no plan");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "").trim());
  } catch {
    throw new Error("Groq returned invalid plan JSON");
  }
  const value = parsed as Partial<{
    symbol: string;
    direction: GroqDirection;
    confidence: number;
    reason: string;
  }>;
  const confidence = Number(value.confidence);
  if (typeof value.symbol !== "string" || !value.symbol.trim())
    throw new Error("Groq returned no market");
  if (!value.direction || !["OVER2", "UNDER7", "NONE"].includes(value.direction))
    throw new Error("Groq returned an invalid direction");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error("Groq returned an invalid confidence");
  return {
    symbol: value.symbol.trim(),
    direction: value.direction,
    confidence,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 240) : "No reason supplied",
  };
}
