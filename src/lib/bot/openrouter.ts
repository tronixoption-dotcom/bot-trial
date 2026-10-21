import type { GroqAutonomousInput, GroqDirection, GroqSignal, GroqSignalInput } from "./groq";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

export const DEFAULT_OPENROUTER_MODELS = [
  "openai/gpt-oss-120b:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
];

type OpenRouterDirection = GroqDirection;

interface OpenRouterModel {
  id?: string;
  architecture?: {
    input_modalities?: string[];
  };
}

interface OpenRouterPayload {
  data?: OpenRouterModel[];
  error?: {
    message?: string;
  };
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

interface ParsedResult {
  direction?: unknown;
  confidence?: unknown;
  reason?: unknown;
  symbol?: unknown;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function openRouterError(payload: OpenRouterPayload | null, status: number) {
  return payload?.error?.message
    ? String(payload.error.message)
    : `OpenRouter request failed (${status})`;
}

export async function listOpenRouterModels(apiKey: string): Promise<string[]> {
  const response = await fetch(MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  const payload = (await response.json().catch(() => null)) as OpenRouterPayload | null;
  if (!response.ok) throw new Error(openRouterError(payload, response.status));
  const available = Array.isArray(payload?.data)
    ? payload.data
        .filter((model) => {
          const modalities = model.architecture?.input_modalities;
          return !!model.id && (!modalities || modalities.includes("text"));
        })
        .map((model) => model.id!)
    : [];
  const ranking = new Map(DEFAULT_OPENROUTER_MODELS.map((model, index) => [model, index]));
  return [...new Set<string>(available)].sort(
    (a, b) =>
      (ranking.get(a) ?? DEFAULT_OPENROUTER_MODELS.length) -
      (ranking.get(b) ?? DEFAULT_OPENROUTER_MODELS.length),
  );
}

async function completeOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
  schema: object,
): Promise<OpenRouterPayload> {
  const send = (response_format?: object) =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          typeof window !== "undefined" ? window.location.origin : "https://profitsccape.online",
        "X-OpenRouter-Title": "One Tick Trade Guard",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        ...(response_format ? { response_format } : {}),
        messages,
      }),
    });
  let response = await send({
    type: "json_schema",
    json_schema: { name: "trade_result", strict: true, schema },
  });
  let payload = (await response.json().catch(() => null)) as OpenRouterPayload | null;
  if (!response.ok) {
    response = await send({ type: "json_object" });
    payload = (await response.json().catch(() => null)) as OpenRouterPayload | null;
  }
  if (!response.ok) {
    response = await send();
    payload = (await response.json().catch(() => null)) as OpenRouterPayload | null;
  }
  if (!response.ok) throw new Error(openRouterError(payload, response.status));
  if (!payload) throw new Error("OpenRouter returned an empty response");
  return payload;
}

function parseJson(content: unknown, label: string): ParsedResult {
  if (typeof content !== "string") throw new Error(`OpenRouter returned no ${label}`);
  try {
    const value: unknown = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "").trim());
    if (!isRecord(value)) throw new Error("Expected a JSON object");
    return value as ParsedResult;
  } catch {
    throw new Error(`OpenRouter returned invalid ${label} JSON`);
  }
}

function validateSignal(value: unknown): GroqSignal {
  const result = parseJson(value, "signal");
  const confidence = Number(result.confidence);
  if (
    typeof result.direction !== "string" ||
    !["OVER2", "UNDER7", "NONE"].includes(result.direction)
  )
    throw new Error("OpenRouter returned an invalid direction");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error("OpenRouter returned an invalid confidence");
  return {
    direction: result.direction as OpenRouterDirection,
    confidence,
    reason: typeof result.reason === "string" ? result.reason.slice(0, 240) : "No reason supplied",
  };
}

export async function requestOpenRouterSignal(
  apiKey: string,
  model: string,
  input: GroqSignalInput,
): Promise<GroqSignal> {
  const payload = await completeOpenRouter(
    apiKey,
    model,
    [
      {
        role: "system",
        content:
          'You are a conservative trading risk reviewer. Return JSON only: {"direction":"OVER2"|"UNDER7"|"NONE","confidence":0..1,"reason":"short explanation"}. Choose NONE when evidence is weak or conflicting. Never invent data or recommend increasing stake.',
      },
      { role: "user", content: JSON.stringify(input) },
    ],
    160,
    signalSchema,
  );
  return validateSignal(payload?.choices?.[0]?.message?.content);
}

export async function requestOpenRouterPlan(
  apiKey: string,
  model: string,
  input: GroqAutonomousInput,
): Promise<{ symbol: string; direction: GroqDirection; confidence: number; reason: string }> {
  const payload = await completeOpenRouter(
    apiKey,
    model,
    [
      {
        role: "system",
        content:
          'You are a conservative demo-only trading planner. Return JSON only: {"symbol":"exact supplied symbol","direction":"OVER2"|"UNDER7"|"NONE","confidence":0..1,"reason":"short explanation"}. Select only a fresh supplied market. Choose NONE when evidence is weak or conflicting. Never increase stake, invent markets, or promise profit.',
      },
      { role: "user", content: JSON.stringify(input) },
    ],
    220,
    planSchema,
  );
  const value = parseJson(payload?.choices?.[0]?.message?.content, "plan");
  const confidence = Number(value.confidence);
  if (typeof value.symbol !== "string" || !value.symbol.trim())
    throw new Error("OpenRouter returned no market");
  if (typeof value.direction !== "string" || !["OVER2", "UNDER7", "NONE"].includes(value.direction))
    throw new Error("OpenRouter returned an invalid direction");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error("OpenRouter returned an invalid confidence");
  return {
    symbol: value.symbol.trim(),
    direction: value.direction as OpenRouterDirection,
    confidence,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 240) : "No reason supplied",
  };
}
