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
