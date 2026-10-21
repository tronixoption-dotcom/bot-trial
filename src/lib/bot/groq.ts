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
const MODELS_ENDPOINT = "https://api.groq.com/openai/v1/models";
export const DEFAULT_GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "qwen/qwen3.8-27b",
];
const strictModels = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
const signalSchema = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["OVER2", "UNDER7", "NONE"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["direction", "confidence", "reason"],
  additionalProperties: false,
};
const planSchema = {
  type: "object",
  properties: {
    symbol: { type: "string" },
    direction: { type: "string", enum: ["OVER2", "UNDER7", "NONE"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["symbol", "direction", "confidence", "reason"],
  additionalProperties: false,
};

function responseFormat(model: string, name: string, schema: object) {
  return strictModels.has(model)
    ? { type: "json_schema", json_schema: { name, strict: true, schema } }
    : { type: "json_object" };
}

function groqError(payload: any, status: number) {
  const failure = payload?.error?.failed_generation;
  const detail = typeof failure === "string" ? failure : failure?.reason;
  return payload?.error?.message
    ? `${payload.error.message}${detail ? ` (${detail})` : ""}`
    : `Groq request failed (${status})`;
}

export async function listGroqModels(apiKey: string): Promise<string[]> {
  const response = await fetch(MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(groqError(payload, response.status));
  const available = Array.isArray(payload?.data)
    ? payload.data
        .filter((model: any) => model?.id && model?.active !== false)
        .map((model: any) => String(model.id))
    : [];
  const ranking = new Map(DEFAULT_GROQ_MODELS.map((model, index) => [model, index]));
  return [...new Set<string>(available as string[])].sort(
    (a, b) =>
      (ranking.get(a) ?? DEFAULT_GROQ_MODELS.length) -
      (ranking.get(b) ?? DEFAULT_GROQ_MODELS.length),
  );
}

async function completeGroq(
  apiKey: string,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxCompletionTokens: number,
  format: object,
) {
  const send = (response_format?: object) =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: maxCompletionTokens,
        ...(response_format ? { response_format } : {}),
        messages,
      }),
    });
  let response = await send(format);
  let payload = await response.json().catch(() => null);
  // Some account/model combinations reject JSON mode with failed_generation.
  // Retry once as plain text; the parser still requires valid JSON before use.
  if (!response.ok && payload?.error?.failed_generation) {
    response = await send();
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) throw new Error(groqError(payload, response.status));
  return payload;
}

export async function requestGroqSignal(
  apiKey: string,
  model: string,
  input: GroqSignalInput,
): Promise<GroqSignal> {
  const payload = await completeGroq(
    apiKey,
    model,
    [
      {
        role: "system",
        content:
          'You are a conservative trading risk reviewer. Return JSON only: {"direction":"OVER2"|"UNDER7"|"NONE","confidence":0..1,"reason":"short explanation"}. You must choose NONE when the evidence is weak, conflicting, or does not support the proposed direction. Never invent data and never recommend increasing stake.',
      },
      { role: "user", content: JSON.stringify(input) },
    ],
    160,
    responseFormat(model, "trading_signal", signalSchema),
  );
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
  const payload = await completeGroq(
    apiKey,
    model,
    [
      {
        role: "system",
        content:
          'You are a conservative demo-only trading planner. Return JSON only: {"symbol":"exact supplied symbol","direction":"OVER2"|"UNDER7"|"NONE","confidence":0..1,"reason":"short explanation"}. Select only a fresh supplied market. Choose NONE when evidence is weak or conflicting. Do not increase stake, invent markets, or promise profit. This is a proposal, not permission to bypass platform safety checks.',
      },
      { role: "user", content: JSON.stringify(input) },
    ],
    220,
    responseFormat(model, "autonomous_trading_plan", planSchema),
  );
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
