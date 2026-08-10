import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";

const APP_VERSION = "0.1.0";
const APP_NAME = "Codex Pocket";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const RUNTIME_DIR = path.join(PROJECT_ROOT, ".codex-pocket");
const ENV_FILE = path.join(PROJECT_ROOT, ".env");
const THREADS_FILE = path.join(RUNTIME_DIR, "threads.json");
const DEVICES_FILE = path.join(RUNTIME_DIR, "devices.json");
const PORT = parsePort(process.env.PORT ?? "8787");
const HOST = process.env.HOST ?? "127.0.0.1";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const INVITATION_TTL_MS = 5 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PROMPT_LENGTH = 16_000;
const MAX_THREADS = 80;
const LOCAL_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://[::1]:${PORT}`,
]);

if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  throw new Error("HOST must remain a loopback address. Use Tailscale Serve or another authenticated HTTPS gateway for phone access.");
}

const publicUrl = normalizePublicUrl(process.env.PUBLIC_URL, HOST, PORT);
const publicOrigin = publicUrl.origin;
const allowedOrigins = new Set([...LOCAL_ORIGINS, publicOrigin]);
let allowedRoots = await loadAllowedRoots();
let projects = buildProjects(allowedRoots);
let projectById = new Map(projects.map((project) => [project.id, project]));
let registry;
let deviceRegistry;

let invitation = createInvitation();
const sessions = new Map();
const approvals = new Map();
const activeTurns = new Map();
const pendingTurnStarts = new Set();
const threadWriters = new Map();
const loadedThreads = new Set();
let bridge;
let modelCache = { loadedAt: 0, models: [] };

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self'",
  );
  if (isMutatingMethod(req.method) && !isAllowedBrowserOrigin(req)) {
    res.status(403).json({ error: "Untrusted browser origin." });
    return;
  }
  next();
});
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, appServer: bridge.status, host: os.hostname() });
});

app.get("/api/bootstrap", asyncHandler(async (req, res) => {
  if (!isLocalAdminRequest(req)) {
    res.status(403).json({ error: "This pairing QR code is only available from the local computer." });
    return;
  }
  refreshInvitationIfExpired();
  const pairingUrl = `${publicUrl.toString()}?pair=${encodeURIComponent(invitation.token)}`;
  const qrDataUrl = await QRCode.toDataURL(pairingUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280,
    color: { dark: "#151815", light: "#f4f6f0" },
  });
  res.json({
    pairingUrl,
    pairingCode: invitation.code,
    expiresAt: invitation.expiresAt,
    qrDataUrl,
    publicReachable: !isLoopbackUrl(publicUrl),
  });
}));

app.post("/api/pair", (req, res, next) => {
  const clientIp = clientAddress(req);
  if (!pairingAttempts.allow(clientIp)) {
    res.status(429).json({ error: "Too many pairing attempts. Try again shortly." });
    return;
  }
  next();
}, asyncHandler(async (req, res) => {
  refreshInvitationIfExpired();
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const code = typeof req.body?.code === "string" ? normalizePairingCode(req.body.code) : "";
  const tokenMatches = token.length > 0 && secretsMatch(hashSecret(token), invitation.tokenHash);
  const codeMatches = code.length > 0 && secretsMatch(hashSecret(code), invitation.codeHash);
  if (!tokenMatches && !codeMatches) {
    res.status(401).json({ error: "The pairing link or code is invalid or has expired." });
    return;
  }

  const { rawToken, device } = await authorizeDevice(req);
  invitation = createInvitation();
  setSessionCookie(req, res, rawToken);
  res.json({ ok: true, deviceId: device.id });
}));

app.post("/api/local-session", requireLocalAdmin, asyncHandler(async (req, res) => {
  if (req.session) {
    res.json({ ok: true, deviceId: req.session.deviceId, existing: true });
    return;
  }
  const { rawToken, device } = await authorizeDevice(req, `${describeUserAgent(req.headers["user-agent"])}（本机）`);
  setSessionCookie(req, res, rawToken);
  res.json({ ok: true, deviceId: device.id });
}));

app.post("/api/logout", requireSession, (req, res) => {
  sessions.delete(req.session.key);
  closeSocketsForSession(req.session.id, "This browser logged out.");
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/admin/sessions", requireLocalAdmin, (req, res) => {
  res.json({ sessions: listSessions(req.session?.id) });
});

app.post("/api/admin/sessions/revoke-all", requireLocalAdmin, asyncHandler(async (req, res) => {
  const keepDeviceId = req.session?.deviceId ?? null;
  const revoked = await revokeAllDevicesExcept(keepDeviceId);
  res.json({ ok: true, revoked });
}));

app.post("/api/admin/sessions/:sessionId/revoke", requireLocalAdmin, asyncHandler(async (req, res) => {
  const device = deviceRegistry.get(req.params.sessionId);
  if (!device || device.revokedAt) {
    res.status(404).json({ error: "That device authorization is no longer active." });
    return;
  }
  if (device.id === req.session?.deviceId) {
    res.status(409).json({ error: "The current computer session cannot be revoked here." });
    return;
  }
  await revokeDevice(device.id);
  res.json({ ok: true });
}));

app.get("/api/session", requireSession, (req, res) => {
  res.json({
    app: APP_NAME,
    version: APP_VERSION,
    host: os.hostname(),
    platform: process.platform,
    appServer: bridge.status,
    projects: projects.map(publicProject),
    approvals: listApprovals(),
  });
});

app.get("/api/models", requireSession, asyncHandler(async (req, res) => {
  const models = await getModelCatalog();
  res.json({ models: models.map(publicModel) });
}));

app.get("/api/projects", requireSession, (req, res) => {
  res.json({ projects: projects.map(publicProject) });
});

app.get("/api/admin/projects", requireLocalAdmin, (req, res) => {
  res.json({ projects: projects.map(publicProject) });
});

app.get("/api/admin/project-candidates", requireLocalAdmin, asyncHandler(async (req, res) => {
  res.json({ candidates: await discoverProjectCandidates() });
}));

app.post("/api/admin/projects", requireLocalAdmin, asyncHandler(async (req, res) => {
  const roots = await validateProjectRoots(req.body?.roots);
  await persistAllowedRoots(roots);
  applyAllowedRoots(roots);
  res.json({ ok: true, projects: projects.map(publicProject) });
}));

app.get("/api/threads", requireSession, asyncHandler(async (req, res) => {
  await syncCodexThreads();
  res.json({ threads: registry.list().map(publicThread) });
}));

app.get("/api/threads/:threadId", requireSession, asyncHandler(async (req, res) => {
  const thread = requireOwnedThread(req.params.threadId);
  let history = { timeline: [] };
  try {
    await bridge.start();
    const result = await bridge.request("thread/read", { threadId: thread.id, includeTurns: true });
    history = extractThreadHistory(result?.thread);
  } catch (error) {
    history = { timeline: [], unavailable: friendlyError(error) };
  }
  res.json({ thread: publicThread(thread), history });
}));

app.post("/api/threads", requireSession, asyncHandler(async (req, res) => {
  const project = projectById.get(String(req.body?.projectId ?? ""));
  const prompt = validatePrompt(req.body?.prompt);
  const settings = await resolveModelSettings(req.body?.settings);
  if (!project) {
    res.status(400).json({ error: "Choose one of the approved project directories." });
    return;
  }

  await bridge.start();
  const created = await bridge.request("thread/start", {
    cwd: project.cwd,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    ...threadStartSettings(settings),
  });
  const threadId = created?.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("Codex did not return a thread id.");
  }

  const thread = {
    id: threadId,
    cwd: project.cwd,
    projectId: project.id,
    title: makeTitle(prompt),
    status: "starting",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeTurnId: null,
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    serviceTier: settings.serviceTier ?? null,
  };
  loadedThreads.add(thread.id);
  await registry.upsert(thread);
  const turn = await startTurn(thread, prompt, req.session);
  res.status(201).json({ thread: publicThread(registry.get(thread.id)), turnId: turn.id });
}));

app.post("/api/threads/:threadId/messages", requireSession, asyncHandler(async (req, res) => {
  const thread = requireOwnedThread(req.params.threadId);
  const prompt = validatePrompt(req.body?.prompt);
  await bridge.start();
  if (!loadedThreads.has(thread.id)) {
    await bridge.request("thread/resume", {
      threadId: thread.id,
      cwd: thread.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...threadStartSettings(thread),
    });
    loadedThreads.add(thread.id);
  }
  const turn = await startTurn(thread, prompt, req.session);
  res.status(201).json({ thread: publicThread(registry.get(thread.id)), turnId: turn.id });
}));

app.post("/api/threads/:threadId/retry", requireSession, asyncHandler(async (req, res) => {
  const thread = requireOwnedThread(req.params.threadId);
  if (!["failed", "interrupted"].includes(thread.status)) {
    throw threadRetryError("只有失败或已停止的任务可以重试。");
  }
  await bridge.start();
  const result = await bridge.request("thread/read", { threadId: thread.id, includeTurns: true });
  const history = extractThreadHistory(result?.thread);
  const prompt = [...history.timeline].reverse().find((entry) => entry.type === "message" && entry.role === "user")?.text;
  if (!prompt) throw threadRetryError("找不到上一次任务指令，无法自动重试。");
  if (!loadedThreads.has(thread.id)) {
    await bridge.request("thread/resume", {
      threadId: thread.id,
      cwd: thread.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...threadStartSettings(thread),
    });
    loadedThreads.add(thread.id);
  }
  const turn = await startTurn(thread, prompt, req.session);
  res.status(201).json({ thread: publicThread(registry.get(thread.id)), turnId: turn.id, prompt });
}));

app.post("/api/threads/:threadId/release", requireSession, asyncHandler(async (req, res) => {
  const thread = requireOwnedThread(req.params.threadId);
  const turnId = activeTurns.get(thread.id) ?? thread.activeTurnId;
  if (turnId) {
    await bridge.start();
    await bridge.request("turn/interrupt", { threadId: thread.id, turnId });
    const updated = await updateThread(thread.id, { status: "stopping", activeTurnId: turnId });
    res.json({ ok: true, status: "stopping", thread: publicThread(updated) });
    return;
  }
  if (["starting", "running", "approval", "stopping"].includes(thread.status)) {
    throw threadRetryError("Codex 仍在执行这个任务，无法安全释放；请在原设备停止任务。");
  }
  threadWriters.delete(thread.id);
  const updated = await updateThread(thread.id, { activeTurnId: null });
  res.json({ ok: true, status: thread.status, thread: publicThread(updated) });
}));

app.post("/api/threads/:threadId/interrupt", requireSession, asyncHandler(async (req, res) => {
  const thread = requireOwnedThread(req.params.threadId);
  const turnId = activeTurns.get(thread.id) ?? thread.activeTurnId;
  if (!turnId) {
    res.status(409).json({ error: "This task is not currently running." });
    return;
  }
  await bridge.start();
  await bridge.request("turn/interrupt", { threadId: thread.id, turnId });
  await updateThread(thread.id, { status: "stopping" });
  res.json({ ok: true });
}));

app.get("/api/approvals", requireSession, (req, res) => {
  res.json({ approvals: listApprovals() });
});

app.post("/api/approvals/:approvalId", requireSession, asyncHandler(async (req, res) => {
  const approval = approvals.get(req.params.approvalId);
  if (!approval || !registry.has(approval.threadId)) {
    res.status(404).json({ error: "That approval request is no longer pending." });
    return;
  }
  const action = String(req.body?.action ?? "");
  const response = approvalResponse(approval, action);
  if (!response) {
    res.status(400).json({ error: "That approval action is not available." });
    return;
  }
  bridge.respond(approval.requestId, response);
  approvals.delete(approval.id);
  if (action === "stop") {
    const turnId = activeTurns.get(approval.threadId) ?? approval.turnId;
    if (turnId) {
      await bridge.request("turn/interrupt", { threadId: approval.threadId, turnId }).catch(() => undefined);
    }
  }
  await updateThread(approval.threadId, { status: action === "stop" ? "stopping" : "running" });
  broadcast({ type: "approval_resolved", approvalId: approval.id });
  res.json({ ok: true });
}));

app.use(express.static(PUBLIC_DIR, {
  etag: false,
  maxAge: 0,
  index: "index.html",
}));

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const message = friendlyError(error);
  const status = error?.statusCode ?? 500;
  console.error("Request failed:", error);
  res.status(status).json({ error: message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
const sockets = new Set();

server.on("upgrade", (req, socket, head) => {
  const originIsTrusted = typeof req.headers.origin === "string" && allowedOrigins.has(req.headers.origin);
  const session = getSession(req);
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  if (requestUrl.pathname !== "/ws" || !originIsTrusted || !session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, session);
  });
});

wss.on("connection", (ws, req, session) => {
  sockets.add(ws);
  ws.sessionId = session.id;
  sendSocket(ws, {
    type: "snapshot",
    appServer: bridge.status,
    threads: registry.list().map(publicThread),
    approvals: listApprovals(),
  });
  ws.on("message", () => {
    sendSocket(ws, { type: "error", message: "Use the authenticated HTTP API for commands." });
  });
  ws.on("close", () => sockets.delete(ws));
  ws.on("error", () => sockets.delete(ws));
});

async function startServer() {
  bridge = new CodexBridge(CODEX_BIN);
  bridge.on("notification", (message) => {
    void handleCodexNotification(message);
  });
  bridge.on("serverRequest", (message) => {
    void handleCodexRequest(message);
  });
  bridge.on("state", (status) => {
    broadcast({ type: "app_server", appServer: status });
  });

  try {
    await bridge.start();
  } catch (error) {
    console.error("Codex app-server was not ready at startup:", friendlyError(error));
  }

  server.listen(PORT, HOST, () => {
    console.log(`${APP_NAME} listening on ${localAddress(HOST, PORT)}`);
    console.log(`Approved project roots: ${allowedRoots.join(", ")}`);
    printInvitation();
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function shutdown() {
  console.log("\nStopping Codex Pocket...");
  bridge.stop();
  for (const socket of sockets) socket.close(1001, "Server shutting down");
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

async function startTurn(thread, prompt, session) {
  if (pendingTurnStarts.has(thread.id) || activeTurns.has(thread.id) || thread.activeTurnId || ["running", "approval", "stopping"].includes(thread.status)) {
    throw threadBusyError();
  }

  pendingTurnStarts.add(thread.id);
  try {
    const result = await bridge.request("turn/start", {
      threadId: thread.id,
      cwd: thread.cwd,
      approvalPolicy: "on-request",
      input: [{ type: "text", text: prompt, text_elements: [] }],
      sandboxPolicy: workspacePolicy(thread.cwd),
      ...turnStartSettings(thread),
    });
    const turnId = result?.turn?.id;
    if (typeof turnId !== "string" || turnId.length === 0) {
      throw new Error("Codex did not return a turn id.");
    }
    activeTurns.set(thread.id, turnId);
    threadWriters.set(thread.id, {
      device: session?.device ?? "本机设备",
      startedAt: Date.now(),
      sessionId: session?.id ?? null,
    });
    await updateThread(thread.id, {
      status: "running",
      activeTurnId: turnId,
      updatedAt: Date.now(),
    });
    return { id: turnId };
  } catch (error) {
    if (/already has an active writer/i.test(error?.message ?? "")) throw threadBusyError(true);
    throw error;
  } finally {
    pendingTurnStarts.delete(thread.id);
  }
}

async function getModelCatalog() {
  if (modelCache.models.length > 0 && Date.now() - modelCache.loadedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.models;
  }
  await bridge.start();
  const result = await bridge.request("model/list", {});
  const models = Array.isArray(result?.data)
    ? result.data.filter((model) => typeof model?.id === "string" && !model.hidden)
    : [];
  modelCache = { loadedAt: Date.now(), models };
  return models;
}

function publicModel(model) {
  return {
    id: model.id,
    displayName: model.displayName || model.model || model.id,
    description: typeof model.description === "string" ? model.description : "",
    isDefault: Boolean(model.isDefault),
    defaultReasoningEffort: model.defaultReasoningEffort || "",
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((effort) => ({
        id: effort.reasoningEffort,
        description: effort.description || "",
      }))
      : [],
    serviceTiers: Array.isArray(model.serviceTiers)
      ? model.serviceTiers.map((tier) => ({ id: tier.id, name: tier.name || tier.id, description: tier.description || "" }))
      : [],
  };
}

async function resolveModelSettings(rawSettings) {
  if (rawSettings === undefined || rawSettings === null) return {};
  if (typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    const error = new Error("Model settings are invalid.");
    error.statusCode = 400;
    throw error;
  }
  const modelId = typeof rawSettings.model === "string" ? rawSettings.model.trim() : "";
  const effort = typeof rawSettings.effort === "string" ? rawSettings.effort.trim() : "";
  const serviceTier = typeof rawSettings.serviceTier === "string" ? rawSettings.serviceTier.trim() : "";
  if (!modelId && !effort && !serviceTier) return {};

  const model = (await getModelCatalog()).find((entry) => entry.id === modelId);
  if (!model) {
    const error = new Error("Choose a model from the available model list.");
    error.statusCode = 400;
    throw error;
  }
  const supportedEfforts = new Set((model.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort));
  if (effort && !supportedEfforts.has(effort)) {
    const error = new Error("That reasoning level is not supported by the selected model.");
    error.statusCode = 400;
    throw error;
  }
  const supportedTiers = new Set((model.serviceTiers ?? []).map((entry) => entry.id));
  if (serviceTier && !supportedTiers.has(serviceTier)) {
    const error = new Error("That service tier is not supported by the selected model.");
    error.statusCode = 400;
    throw error;
  }
  return {
    model: model.id,
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

function threadStartSettings(settings) {
  return settings?.model ? { model: settings.model } : {};
}

function turnStartSettings(settings) {
  return {
    ...(settings?.model ? { model: settings.model } : {}),
    ...(settings?.effort ? { effort: settings.effort } : {}),
    ...(settings?.serviceTier ? { serviceTier: settings.serviceTier } : {}),
  };
}

async function syncCodexThreads() {
  await bridge.start();
  const result = await bridge.request("thread/list", { limit: 100 });
  const records = [];
  for (const summary of Array.isArray(result?.data) ? result.data : []) {
    if (summary?.ephemeral || typeof summary?.id !== "string" || typeof summary?.cwd !== "string") continue;
    const project = projectForCwd(summary.cwd);
    if (!project) continue;
    const existing = registry.get(summary.id);
    const summaryStatus = codexThreadStatus(summary.status?.type);
    const status = existing && ["running", "starting", "approval", "stopping"].includes(existing.status) && summaryStatus === "completed"
      ? existing.status
      : summaryStatus;
    records.push({
      id: summary.id,
      cwd: summary.cwd,
      projectId: project.id,
      title: existing?.title ?? makeTitle(typeof summary.name === "string" ? summary.name : typeof summary.preview === "string" ? summary.preview : "历史任务"),
      status,
      createdAt: existing?.createdAt ?? toMillis(summary.createdAt),
      updatedAt: Math.max(existing?.updatedAt ?? 0, toMillis(summary.updatedAt), toMillis(summary.recencyAt)),
      activeTurnId: existing?.activeTurnId ?? null,
      model: existing?.model ?? (typeof summary.model === "string" ? summary.model : null),
      effort: existing?.effort ?? null,
      serviceTier: existing?.serviceTier ?? null,
    });
    if (["running", "approval"].includes(status) && !threadWriters.has(summary.id)) {
      threadWriters.set(summary.id, { device: "Codex/其他设备", startedAt: Date.now(), sessionId: null });
    }
    if (["completed", "interrupted", "failed"].includes(status)) threadWriters.delete(summary.id);
  }
  await registry.upsertMany(records);
}

function projectForCwd(cwd) {
  const resolved = path.resolve(cwd);
  const exact = projects.find((project) => project.cwd === resolved);
  if (exact) return exact;
  return projects.find((project) => {
    const relative = path.relative(project.cwd, resolved);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  }) ?? null;
}

function codexThreadStatus(type) {
  if (["active", "inProgress", "running"].includes(type)) return "running";
  if (["approval", "waitingForApproval"].includes(type)) return "approval";
  if (["failed", "error", "systemError"].includes(type)) return "failed";
  if (type === "interrupted") return "interrupted";
  return "completed";
}

function toMillis(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function workspacePolicy(cwd) {
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  };
}

async function handleCodexNotification(message) {
  const event = visibleEvent(message);
  if (!event?.threadId || !registry.has(event.threadId)) return;

  if (event.type === "turn_started") {
    activeTurns.set(event.threadId, event.turnId);
    if (!threadWriters.has(event.threadId)) {
      threadWriters.set(event.threadId, { device: "Codex/其他设备", startedAt: Date.now(), sessionId: null });
    }
    await updateThread(event.threadId, { status: "running", activeTurnId: event.turnId });
  }
  if (event.type === "turn_completed") {
    activeTurns.delete(event.threadId);
    threadWriters.delete(event.threadId);
    const status = event.status === "completed" ? "completed" : event.status === "interrupted" ? "interrupted" : "failed";
    await updateThread(event.threadId, { status, activeTurnId: null });
  }
  if (event.type === "thread_status") {
    const status = mapCodexStatus(event.status);
    if (["completed", "interrupted", "failed"].includes(status)) {
      activeTurns.delete(event.threadId);
      threadWriters.delete(event.threadId);
    } else if (["running", "approval"].includes(status) && !threadWriters.has(event.threadId)) {
      threadWriters.set(event.threadId, { device: "Codex/其他设备", startedAt: Date.now(), sessionId: null });
    }
    await updateThread(event.threadId, { status, ...(status === "completed" || status === "interrupted" || status === "failed" ? { activeTurnId: null } : {}) });
  }
  broadcast(event);
}

async function handleCodexRequest(message) {
  const method = message.method;
  if (isApprovalMethod(method)) {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!registry.has(threadId)) {
      bridge.respondError(message.id, -32003, "This Codex Pocket instance does not own the requested thread.");
      return;
    }
    const approval = {
      id: crypto.randomUUID(),
      requestId: message.id,
      method,
      threadId,
      turnId: typeof params.turnId === "string" ? params.turnId : null,
      itemId: typeof params.itemId === "string" ? params.itemId : null,
      command: safeString(params.command),
      cwd: safeString(params.cwd),
      reason: safeString(params.reason),
      permissions: params.permissions ?? null,
      createdAt: Date.now(),
    };
    approvals.set(approval.id, approval);
    await updateThread(threadId, { status: "approval" });
    broadcast({ type: "approval_requested", approval: publicApproval(approval) });
    return;
  }
  bridge.respondError(message.id, -32601, "This callback is not supported by Codex Pocket.");
}

function visibleEvent(message) {
  const params = message.params ?? {};
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  if (!threadId) return null;
  const turnId = typeof params.turnId === "string" ? params.turnId : params.turn?.id ?? null;
  if (message.method === "item/agentMessage/delta") {
    return {
      type: "agent_delta",
      threadId,
      turnId,
      itemId: safeString(params.itemId) || crypto.randomUUID(),
      delta: safeString(params.delta),
      at: Date.now(),
    };
  }
  if (message.method === "item/commandExecution/outputDelta") {
    return {
      type: "command_output",
      threadId,
      turnId,
      itemId: safeString(params.itemId) || crypto.randomUUID(),
      delta: safeString(params.delta),
      at: Date.now(),
    };
  }
  if (message.method === "turn/started") {
    return { type: "turn_started", threadId, turnId, at: Date.now() };
  }
  if (message.method === "turn/completed") {
    return { type: "turn_completed", threadId, turnId, status: safeString(params.turn?.status) || "failed", at: Date.now() };
  }
  if (message.method === "thread/status/changed") {
    return { type: "thread_status", threadId, status: safeString(params.status), at: Date.now() };
  }
  if (message.method === "item/started" || message.method === "item/completed") {
    const item = params.item ?? {};
    if (["userMessage", "agentMessage"].includes(safeString(item.type))) return null;
    return {
      type: "activity",
      threadId,
      turnId,
      itemId: safeString(params.itemId) || safeString(item.id) || crypto.randomUUID(),
      phase: message.method === "item/started" ? "started" : "completed",
      label: describeItem(item),
      at: Date.now(),
    };
  }
  if (message.method === "turn/plan/updated") {
    return {
      type: "activity",
      threadId,
      turnId,
      phase: "updated",
      label: safeString(params.explanation) || "任务计划已更新",
      at: Date.now(),
    };
  }
  if (message.method === "error") {
    return {
      type: "error",
      threadId,
      turnId,
      message: safeString(params.error?.message) || "Codex returned an error.",
      at: Date.now(),
    };
  }
  return null;
}

function describeItem(item) {
  const type = safeString(item.type);
  if (type === "commandExecution") return safeString(item.command) || "正在运行命令";
  if (type === "fileChange") return "正在修改文件";
  if (type === "reasoning") return "正在分析";
  if (type === "agentMessage") return "正在整理回复";
  if (type === "webSearch") return "正在检索资料";
  if (type === "mcpToolCall") return "正在调用工具";
  return type ? `正在处理 ${type}` : "任务状态已更新";
}

function approvalResponse(approval, action) {
  if (approval.method === "item/permissions/requestApproval") {
    if (action === "keep_restricted" || action === "stop") {
      return { permissions: {}, scope: "turn" };
    }
    return null;
  }
  const modern = approval.method.startsWith("item/");
  if (modern) {
    if (action === "allow") return { decision: "accept" };
    if (action === "deny") return { decision: "decline" };
    if (action === "stop") return { decision: "cancel" };
    return null;
  }
  if (action === "allow") return { decision: "approved" };
  if (action === "deny") return { decision: { denied: { rejection: "Declined from Codex Pocket." } } };
  if (action === "stop") return { decision: "abort" };
  return null;
}

function isApprovalMethod(method) {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(method);
}

async function updateThread(threadId, patch) {
  const record = await registry.patch(threadId, { ...patch, updatedAt: Date.now() });
  if (record) broadcast({ type: "thread_updated", thread: publicThread(record) });
  return record;
}

function publicProject(project) {
  return { id: project.id, name: project.name, cwd: project.cwd };
}

function publicThread(thread) {
  const writer = threadWriters.get(thread.id);
  return {
    id: thread.id,
    projectId: thread.projectId,
    cwd: thread.cwd,
    title: thread.title,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    activeTurnId: thread.activeTurnId ?? null,
    model: thread.model ?? null,
    effort: thread.effort ?? null,
    serviceTier: thread.serviceTier ?? null,
    writer: writer ? { device: writer.device, startedAt: writer.startedAt } : null,
  };
}

function publicApproval(approval) {
  return {
    id: approval.id,
    method: approval.method,
    threadId: approval.threadId,
    turnId: approval.turnId,
    command: approval.command,
    cwd: approval.cwd,
    reason: approval.reason,
    permissions: approval.permissions,
    createdAt: approval.createdAt,
  };
}

function listApprovals() {
  return [...approvals.values()]
    .filter((approval) => registry.has(approval.threadId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicApproval);
}

function extractThreadHistory(thread) {
  const timeline = [];
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const type = safeString(item?.type);
      const text = extractItemText(item);
      if (type === "userMessage" && text) {
        timeline.push({ type: "message", role: "user", text, at: item?.createdAt ?? null });
      } else if (type === "agentMessage" && text) {
        timeline.push({ type: "message", role: "assistant", text, at: item?.createdAt ?? null });
      } else if (type && type !== "reasoning") {
        timeline.push({ type: "activity", phase: "completed", label: describeItem(item), at: item?.createdAt ?? null });
      }
    }
  }
  return { timeline };
}

function extractItemText(item) {
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.message === "string") return item.message;
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) {
    return item.content.map((entry) => safeString(entry?.text ?? entry?.content)).filter(Boolean).join("\n");
  }
  return "";
}

function requireOwnedThread(threadId) {
  const thread = registry.get(threadId);
  if (!thread) {
    const error = new Error("This task is outside the allowed projects or is no longer available.");
    error.statusCode = 404;
    throw error;
  }
  return thread;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Pair this browser with the local computer first." });
    return;
  }
  req.session = session;
  next();
}

function requireLocalAdmin(req, res, next) {
  if (!isLocalAdminRequest(req)) {
    res.status(403).json({ error: "Connection management is available only on the local computer." });
    return;
  }
  req.session = getSession(req);
  next();
}

function getSession(req) {
  cleanupSessions();
  const raw = readCookie(req.headers.cookie, "codex_pocket");
  if (!raw) return null;
  const key = hashSecret(raw);
  let session = sessions.get(key);
  const device = deviceRegistry.getByTokenHash(key);
  if (!device || device.revokedAt) {
    sessions.delete(key);
    return null;
  }
  if (!session) session = createSession(raw, device);
  session.lastSeenAt = Date.now();
  if (session.lastSeenAt - device.lastSeenAt > 60 * 1000) {
    void deviceRegistry.touch(device.id, session.lastSeenAt).catch((error) => console.error("Could not update device activity:", error));
  }
  return { key, ...session };
}

function setSessionCookie(req, res, token) {
  const secure = publicUrl.protocol === "https:" || req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("codex_pocket", token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

function clearSessionCookie(req, res) {
  const secure = publicUrl.protocol === "https:" || req.secure || req.headers["x-forwarded-proto"] === "https";
  res.clearCookie("codex_pocket", { httpOnly: true, sameSite: "strict", secure, path: "/" });
}

function cleanupSessions() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now || now - session.lastSeenAt > SESSION_IDLE_TTL_MS) sessions.delete(key);
  }
}

function listSessions(currentSessionId = null) {
  cleanupSessions();
  const activeByDeviceId = new Map();
  for (const session of sessions.values()) {
    const current = activeByDeviceId.get(session.deviceId);
    if (!current || current.lastSeenAt < session.lastSeenAt) activeByDeviceId.set(session.deviceId, session);
  }
  return deviceRegistry.list().map((device) => {
    const session = activeByDeviceId.get(device.id);
    return {
      id: device.id,
      device: device.device,
      createdAt: device.createdAt,
      lastSeenAt: Math.max(device.lastSeenAt, session?.lastSeenAt ?? 0),
      expiresAt: null,
      active: Boolean(session),
      current: session?.id === currentSessionId,
    };
  });
}

function createSession(rawToken, device) {
  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    deviceId: device.id,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_ABSOLUTE_TTL_MS,
    device: device.device,
  };
  sessions.set(hashSecret(rawToken), session);
  return session;
}

async function authorizeDevice(req, deviceLabel = describeUserAgent(req.headers["user-agent"])) {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const device = await deviceRegistry.add({
    id: crypto.randomUUID(),
    tokenHash: hashSecret(rawToken),
    createdAt: now,
    lastSeenAt: now,
    device: deviceLabel,
  });
  createSession(rawToken, device);
  return { rawToken, device };
}

async function revokeDevice(deviceId) {
  await deviceRegistry.revoke(deviceId);
  for (const [key, session] of sessions) {
    if (session.deviceId !== deviceId) continue;
    sessions.delete(key);
    closeSocketsForSession(session.id, "This device authorization was revoked.");
  }
}

async function revokeAllDevicesExcept(keepDeviceId) {
  let revoked = 0;
  for (const device of deviceRegistry.list()) {
    if (device.id === keepDeviceId) continue;
    await revokeDevice(device.id);
    revoked += 1;
  }
  return revoked;
}

function describeUserAgent(userAgent) {
  const value = typeof userAgent === "string" ? userAgent : "";
  if (/iPhone|iPad/i.test(value)) return "iPhone / iPad 浏览器";
  if (/Android/i.test(value)) return "Android 浏览器";
  if (/Macintosh/i.test(value)) return "Mac 浏览器";
  if (/Windows/i.test(value)) return "Windows 浏览器";
  return value ? value.slice(0, 120) : "未知设备";
}

function isAllowedBrowserOrigin(req) {
  const origin = req.headers.origin;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function isLocalAdminRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers.forwarded) return false;
  const origin = req.headers.origin;
  return typeof origin === "undefined" || LOCAL_ORIGINS.has(origin);
}

function isMutatingMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function createInvitation() {
  const token = crypto.randomBytes(32).toString("base64url");
  const code = formatPairingCode(crypto.randomBytes(5).toString("hex").toUpperCase());
  return {
    token,
    tokenHash: hashSecret(token),
    code,
    codeHash: hashSecret(normalizePairingCode(code)),
    expiresAt: Date.now() + INVITATION_TTL_MS,
  };
}

function refreshInvitationIfExpired() {
  if (Date.now() >= invitation.expiresAt) invitation = createInvitation();
}

function printInvitation() {
  refreshInvitationIfExpired();
  console.log(`Open ${localAddress(HOST, PORT)} on this Mac to display a pairing QR code.`);
  console.log(`Manual pairing code (expires in five minutes): ${invitation.code}`);
  if (isLoopbackUrl(publicUrl)) {
    console.log("Set PUBLIC_URL to your HTTPS Tailscale address before scanning from a phone.");
  }
}

function broadcast(payload) {
  for (const socket of sockets) sendSocket(socket, payload);
}

function sendSocket(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function closeSocketsForSession(sessionId, reason) {
  for (const socket of sockets) {
    if (socket.sessionId === sessionId) socket.close(4001, reason);
  }
}

function validatePrompt(value) {
  if (typeof value !== "string") {
    const error = new Error("Enter a task for Codex.");
    error.statusCode = 400;
    throw error;
  }
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    const error = new Error(`Task text must be between 1 and ${MAX_PROMPT_LENGTH} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return prompt;
}

function threadBusyError(stale = false) {
  const error = new Error(stale
    ? "这个任务仍被 Codex 占用，请在原设备停止任务，或重启电脑端服务后再发送。"
    : "这个任务正在由另一台设备执行，请等待完成后再发送。" );
  error.statusCode = 409;
  return error;
}

function threadRetryError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function makeTitle(prompt) {
  return prompt.replace(/\s+/g, " ").slice(0, 96);
}

function mapCodexStatus(status) {
  if (["completed", "interrupted", "failed", "running", "starting", "approval"].includes(status)) return status;
  if (["active", "inProgress"].includes(status)) return "running";
  return status || "unknown";
}

function safeString(value) {
  return typeof value === "string" ? value.slice(0, 20_000) : "";
}

function friendlyError(error) {
  const message = typeof error?.message === "string" ? error.message : "The local Codex service could not complete that request.";
  return message.replace(/\s+/g, " ").slice(0, 500);
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function secretsMatch(left, right) {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function shortHash(value) {
  return hashSecret(value).slice(0, 12);
}

function normalizePairingCode(code) {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function formatPairingCode(hex) {
  const raw = hex.slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normalizePublicUrl(value, host, port) {
  const url = new URL(value ?? localAddress(host, port));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("PUBLIC_URL must use http or https.");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function localAddress(host, port) {
  return host === "::1" ? `http://[::1]:${port}` : `http://${host}:${port}`;
}

function isLoopbackUrl(url) {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  return port;
}

async function loadAllowedRoots() {
  const rawRoots = (process.env.CODEX_POCKET_ROOTS ?? process.cwd())
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (rawRoots.length === 0) throw new Error("CODEX_POCKET_ROOTS must contain at least one directory.");
  const roots = [];
  for (const rawRoot of rawRoots) {
    const resolved = await fs.realpath(path.resolve(rawRoot));
    const details = await fs.stat(resolved);
    if (!details.isDirectory()) throw new Error(`Approved root is not a directory: ${resolved}`);
    roots.push(resolved);
  }
  return [...new Set(roots)];
}

function buildProjects(roots) {
  return roots.map((cwd) => ({
    id: shortHash(cwd),
    name: path.basename(cwd) || cwd,
    cwd,
  }));
}

async function validateProjectRoots(rawRoots) {
  if (!Array.isArray(rawRoots) || rawRoots.length === 0 || rawRoots.length > 20) {
    const error = new Error("Choose between one and twenty project directories.");
    error.statusCode = 400;
    throw error;
  }
  const roots = [];
  for (const rawRoot of rawRoots) {
    if (typeof rawRoot !== "string" || rawRoot.length > 500 || !path.isAbsolute(rawRoot)) {
      const error = new Error("Project paths must be absolute paths.");
      error.statusCode = 400;
      throw error;
    }
    const resolved = await fs.realpath(rawRoot).catch(() => null);
    if (!resolved) {
      const error = new Error(`Project directory does not exist: ${rawRoot}`);
      error.statusCode = 400;
      throw error;
    }
    const details = await fs.stat(resolved);
    if (!details.isDirectory()) {
      const error = new Error(`Project path is not a directory: ${resolved}`);
      error.statusCode = 400;
      throw error;
    }
    if (resolved === path.parse(resolved).root) {
      const error = new Error("The filesystem root cannot be an approved project.");
      error.statusCode = 400;
      throw error;
    }
    roots.push(resolved);
  }
  return [...new Set(roots)];
}

async function discoverProjectCandidates() {
  await bridge.start();
  const result = await bridge.request("thread/list", { limit: 200 });
  const candidates = new Map();
  for (const summary of Array.isArray(result?.data) ? result.data : []) {
    if (summary?.ephemeral || typeof summary?.cwd !== "string") continue;
    const cwd = await fs.realpath(summary.cwd).catch(() => null);
    const details = cwd ? await fs.stat(cwd).catch(() => null) : null;
    if (!cwd || !details?.isDirectory()) continue;
    const current = candidates.get(cwd) ?? {
      id: shortHash(cwd),
      name: path.basename(cwd) || cwd,
      cwd,
      selected: allowedRoots.includes(cwd),
      kind: "codexProject",
      threadCount: 0,
      lastUpdatedAt: 0,
      sampleTitle: "",
    };
    current.threadCount += 1;
    current.lastUpdatedAt = Math.max(current.lastUpdatedAt, toMillis(summary.updatedAt), toMillis(summary.recencyAt));
    if (!current.sampleTitle && typeof summary.name === "string" && summary.name.trim()) current.sampleTitle = makeTitle(summary.name);
    if (!current.sampleTitle && typeof summary.preview === "string" && summary.preview.trim()) current.sampleTitle = makeTitle(summary.preview);
    candidates.set(cwd, current);
  }
  for (const cwd of allowedRoots) {
    if (!candidates.has(cwd)) {
      candidates.set(cwd, {
        id: shortHash(cwd),
        name: path.basename(cwd) || cwd,
        cwd,
        selected: true,
        kind: "configured",
        threadCount: 0,
        lastUpdatedAt: 0,
        sampleTitle: "",
      });
    }
  }
  return [...candidates.values()].sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt || left.name.localeCompare(right.name, "zh-CN"));
}

function applyAllowedRoots(roots) {
  allowedRoots = roots;
  projects = buildProjects(roots);
  projectById = new Map(projects.map((project) => [project.id, project]));
  registry?.setRoots(new Set(roots));
}

async function persistAllowedRoots(roots) {
  let body = "";
  try {
    body = await fs.readFile(ENV_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const encoded = roots.map(escapeEnvValue).join(path.delimiter);
  const line = `CODEX_POCKET_ROOTS="${encoded}"`;
  if (/^CODEX_POCKET_ROOTS=.*$/m.test(body)) body = body.replace(/^CODEX_POCKET_ROOTS=.*$/m, line);
  else body = `${body.trimEnd()}\n${line}\n`;
  const temp = `${ENV_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, ENV_FILE);
  await fs.chmod(ENV_FILE, 0o600);
}

function escapeEnvValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}

function readCookie(header, name) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

class RollingLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  allow(key) {
    const now = Date.now();
    const times = (this.entries.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (times.length >= this.limit) {
      this.entries.set(key, times);
      return false;
    }
    times.push(now);
    this.entries.set(key, times);
    return true;
  }
}

const pairingAttempts = new RollingLimiter(5, 60 * 1000);

class DeviceRegistry {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    this.saveQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      for (const record of Array.isArray(parsed?.devices) ? parsed.devices : []) {
        if (
          typeof record?.id === "string" &&
          typeof record?.tokenHash === "string" &&
          typeof record?.createdAt === "number" &&
          typeof record?.lastSeenAt === "number" &&
          typeof record?.device === "string"
        ) {
          this.records.set(record.id, record);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  getByTokenHash(tokenHash) {
    for (const record of this.records.values()) {
      if (!record.revokedAt && record.tokenHash === tokenHash) return record;
    }
    return null;
  }

  list() {
    return [...this.records.values()]
      .filter((record) => !record.revokedAt)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  async add(record) {
    this.records.set(record.id, record);
    await this.save();
    return record;
  }

  async touch(id, lastSeenAt) {
    const record = this.records.get(id);
    if (!record || record.revokedAt) return;
    record.lastSeenAt = lastSeenAt;
    await this.save();
  }

  async revoke(id) {
    const record = this.records.get(id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = Date.now();
    await this.save();
    return true;
  }

  async save() {
    const write = this.saveQueue.then(async () => {
      const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const body = JSON.stringify({ version: 1, devices: [...this.records.values()] }, null, 2);
      await fs.writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temp, this.file);
      await fs.chmod(this.file, 0o600);
    });
    this.saveQueue = write.catch(() => undefined);
    return write;
  }
}

class ThreadRegistry {
  constructor(file, roots) {
    this.file = file;
    this.roots = roots;
    this.records = new Map();
    this.saveQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      for (const record of Array.isArray(parsed?.threads) ? parsed.threads : []) {
        if (typeof record?.id === "string" && this.isAllowedCwd(record.cwd)) this.records.set(record.id, record);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(id) {
    const record = this.records.get(id) ?? null;
    return record && this.isAllowedCwd(record.cwd) ? record : null;
  }

  has(id) {
    return Boolean(this.get(id));
  }

  list() {
    return [...this.records.values()]
      .filter((record) => this.isAllowedCwd(record.cwd))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_THREADS);
  }

  setRoots(roots) {
    this.roots = roots;
  }

  async upsert(record) {
    this.records.set(record.id, record);
    await this.save();
    return record;
  }

  async upsertMany(records) {
    let changed = false;
    for (const record of records) {
      if (!record?.id || !this.isAllowedCwd(record.cwd)) continue;
      const previous = this.records.get(record.id);
      if (JSON.stringify(previous) === JSON.stringify(record)) continue;
      this.records.set(record.id, record);
      changed = true;
    }
    if (changed) await this.save();
  }

  async patch(id, patch) {
    const current = this.records.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.records.set(id, next);
    await this.save();
    return next;
  }

  async save() {
    const write = this.saveQueue.then(async () => {
      const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const body = JSON.stringify({ version: 1, threads: this.list() }, null, 2);
      await fs.writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temp, this.file);
      await fs.chmod(this.file, 0o600);
    });
    this.saveQueue = write.catch(() => undefined);
    return write;
  }

  isAllowedCwd(cwd) {
    if (typeof cwd !== "string") return false;
    const resolved = path.resolve(cwd);
    for (const root of this.roots) {
      const relative = path.relative(root, resolved);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
    }
    return false;
  }
}

class CodexBridge extends EventEmitter {
  constructor(binary) {
    super();
    this.binary = binary;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.status = { state: "offline", detail: "Not started" };
  }

  async start() {
    if (this.status.state === "ready") return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async startInternal() {
    this.status = { state: "starting", detail: "Starting local Codex" };
    this.emit("state", this.status);
    const child = spawn(this.binary, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleOutput(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.handleExit(child, error));
    child.on("exit", (code, signal) => this.handleExit(child, new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`)));

    const result = await this.request("initialize", {
      clientInfo: { name: "codex-pocket", title: APP_NAME, version: APP_VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.notify("initialized", {});
    this.status = {
      state: "ready",
      detail: "Connected to local Codex",
      platform: result?.platformOs ?? process.platform,
    };
    this.emit("state", this.status);
  }

  stop() {
    if (this.child) this.child.kill();
    this.child = null;
    this.status = { state: "offline", detail: "Stopped" };
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out while handling ${method}.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("The local Codex service is not connected.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleOutput(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex rejected the request."));
        else pending.resolve(message.result);
      } else if (Object.hasOwn(message, "id") && message.method) {
        this.emit("serverRequest", message);
      } else if (message.method) {
        this.emit("notification", message);
      }
    }
  }

  handleExit(child, error) {
    if (child !== this.child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.status = { state: "offline", detail: friendlyError(error) };
    this.emit("state", this.status);
  }
}

registry = new ThreadRegistry(THREADS_FILE, new Set(allowedRoots));
await registry.load();
deviceRegistry = new DeviceRegistry(DEVICES_FILE);
await deviceRegistry.load();
await startServer();
