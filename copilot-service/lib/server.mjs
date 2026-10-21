import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { CopilotClient } from "@github/copilot-sdk";

const port = Number(process.env.PORT || 8787);
const clientId = process.env.GITHUB_CLIENT_ID;
const clientSecret = process.env.GITHUB_CLIENT_SECRET;
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");
const frontendOrigin = (process.env.FRONTEND_ORIGIN || "http://localhost:5173").replace(/\/$/, "");
const secureCookie = publicUrl.startsWith("https://") ? " Secure;" : "";
const sessionSecret = process.env.SESSION_SECRET || clientSecret || "local-development-secret";
const sessions = new Map();
const states = new Map();
const clients = new Map();

if (!clientId || !clientSecret) {
  console.warn("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for Copilot OAuth.");
}

function cookieValue(request, name) {
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function sessionKey() {
  return crypto.createHash("sha256").update(sessionSecret).digest();
}

function sealSession(session) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function openSession(value) {
  try {
    const payload = Buffer.from(value, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

function headers(extra = {}) {
  return {
    "Access-Control-Allow-Origin": frontendOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extra,
  };
}

function send(response, status, body, extra = {}) {
  response.writeHead(
    status,
    headers({ "Content-Type": "application/json; charset=utf-8", ...extra }),
  );
  response.end(JSON.stringify(body));
}

async function jsonBody(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

function sessionFor(request) {
  const id = cookieValue(request, "copilot_session");
  const session = id ? openSession(id) || sessions.get(id) : null;
  if (!session || session.expiresAt < Date.now()) return null;
  return { id: session.id || id, ...session };
}

async function exchange(code) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${publicUrl}/auth/callback`,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token)
    throw new Error(data.error_description || "GitHub OAuth exchange failed");
  return data.access_token;
}

async function githubUser(token) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "one-tick-trade-guard",
    },
  });
  if (!response.ok) throw new Error("Could not verify GitHub account");
  return response.json();
}

function parsePlan(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*|\s*```$/g, "")
    .trim();
  const value = JSON.parse(cleaned);
  if (typeof value.symbol !== "string" || !["OVER2", "UNDER7", "NONE"].includes(value.direction))
    throw new Error("Copilot returned an invalid direction");
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error("Copilot returned an invalid confidence");
  return {
    symbol: value.symbol,
    direction: value.direction,
    confidence,
    reason: String(value.reason || "No reason supplied").slice(0, 240),
  };
}

async function copilotPlan(session, input) {
  let client = clients.get(session.id);
  if (!client) {
    client = new CopilotClient({
      mode: "empty",
      // Authentication belongs to the client, not the individual session.
      // In particular, `gitHubToken` is not a createSession option in the SDK.
      gitHubToken: session.token,
      workingDirectory: "/tmp",
      baseDirectory: "/tmp/copilot",
      logLevel: "error",
    });
    await withTimeout(client.start(), 45_000, "Copilot runtime startup timed out");
    clients.set(session.id, client);
  }
  const copilotSession = await client.createSession({
    model: input.model || process.env.COPILOT_MODEL || "gpt-5.4",
    // Empty mode requires every session to explicitly declare its tools.
    // This planner does not need filesystem, shell, or other tools.
    availableTools: [],
  });
  try {
    const result = await withTimeout(
      copilotSession.sendAndWait({
        prompt: `You are a conservative demo-only trading planner. Return exactly one JSON object and no markdown: {"symbol":"exact supplied symbol","direction":"OVER2"|"UNDER7"|"NONE","confidence":0..1,"reason":"short explanation"}. Choose NONE when evidence is weak. Never increase stake or promise profit. Input: ${JSON.stringify(input)}`,
      }),
      45_000,
      "Copilot response timed out",
    );
    return parsePlan(result?.data?.content);
  } finally {
    await copilotSession.disconnect().catch(() => {});
  }
}

async function copilotModels(session) {
  let client = clients.get(session.id);
  if (!client) {
    client = new CopilotClient({
      mode: "empty",
      gitHubToken: session.token,
      workingDirectory: "/tmp",
      baseDirectory: "/tmp/copilot",
      logLevel: "error",
    });
    await withTimeout(client.start(), 45_000, "Copilot runtime startup timed out");
    clients.set(session.id, client);
  }
  const models = await withTimeout(client.listModels(), 45_000, "Copilot model list timed out");
  return models.map(({ id, name }) => ({ id, name }));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function handler(request, response) {
  const url = new URL(request.url, publicUrl);
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers());
    response.end();
    return;
  }
  try {
    if (url.pathname === "/health") return send(response, 200, { ok: true });
    if (url.pathname === "/auth/login") {
      if (!clientId || !clientSecret)
        return send(response, 503, { error: "GitHub OAuth is not configured" });
      const state = crypto.randomBytes(24).toString("hex");
      states.set(state, Date.now() + 10 * 60_000);
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", `${publicUrl}/auth/callback`);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("scope", "read:user user:email");
      response.writeHead(302, headers({ Location: authorize.toString() }));
      response.end();
      return;
    }
    if (url.pathname === "/auth/callback") {
      if (!url.searchParams.get("code")) return send(response, 400, { error: "GitHub did not return an OAuth code" });
      const stateExpiry = states.get(url.searchParams.get("state"));
      states.delete(url.searchParams.get("state"));
      if (!stateExpiry || stateExpiry < Date.now())
        return send(response, 400, { error: "Invalid or expired OAuth state" });
      const token = await exchange(url.searchParams.get("code"));
      const user = await githubUser(token);
      const id = crypto.randomBytes(32).toString("hex");
      const session = { id, token, login: user.login, expiresAt: Date.now() + 8 * 60 * 60_000 };
      sessions.set(id, session);
      response.writeHead(
        302,
        headers({
          Location: `${frontendOrigin}/?copilot=connected`,
          "Set-Cookie": `copilot_session=${sealSession(session)}; HttpOnly;${secureCookie} SameSite=${secureCookie ? "None" : "Lax"}; Path=/; Max-Age=28800`,
        }),
      );
      response.end();
      return;
    }
    if (url.pathname === "/auth/logout") {
      const session = sessionFor(request);
      if (session) {
        sessions.delete(session.id);
        const client = clients.get(session.id);
        if (client) await client.stop().catch(() => {});
        clients.delete(session.id);
      }
      response.writeHead(
        204,
        headers({
          "Set-Cookie": `copilot_session=; HttpOnly;${secureCookie} SameSite=${secureCookie ? "None" : "Lax"}; Path=/; Max-Age=0`,
        }),
      );
      response.end();
      return;
    }
    if (url.pathname === "/api/status") {
      const session = sessionFor(request);
      return send(response, 200, { connected: !!session, login: session?.login ?? null });
    }
    if (url.pathname === "/api/models") {
      const session = sessionFor(request);
      if (!session) return send(response, 401, { error: "Connect GitHub Copilot first" });
      return send(response, 200, { models: await copilotModels(session) });
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      const session = sessionFor(request);
      if (!session) return send(response, 401, { error: "Connect GitHub Copilot first" });
      const { model, ...input } = await jsonBody(request);
      const plan = await copilotPlan(session, { ...input, model });
      return send(response, 200, plan);
    }
    send(response, 404, { error: "Not found" });
  } catch (error) {
    send(response, 500, {
      error: error instanceof Error ? error.message : "Copilot service error",
    });
  }
}

export default handler;

if (!process.env.VERCEL) {
  const server = http.createServer(handler);
  server.listen(port, () => console.log(`Copilot service listening on ${publicUrl}`));
}
