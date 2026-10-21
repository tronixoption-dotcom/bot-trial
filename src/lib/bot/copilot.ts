import type { GroqAutonomousInput } from "./groq";

export interface CopilotPlan {
  symbol: string;
  direction: "OVER2" | "UNDER7" | "NONE";
  confidence: number;
  reason: string;
}

export async function copilotStatus(baseUrl: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/status`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Copilot service status failed (${response.status})`);
  return response.json() as Promise<{ connected: boolean; login: string | null }>;
}

export async function copilotModels(baseUrl: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/models`, {
    credentials: "include",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error ?? `Copilot models failed (${response.status})`);
  return payload as Promise<{ models: Array<{ id: string; name: string }> }>;
}

export async function requestCopilotPlan(
  baseUrl: string,
  model: string,
  input: GroqAutonomousInput,
) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/plan`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, model }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(payload?.error ?? `Copilot request failed (${response.status})`);
  return payload as CopilotPlan;
}
