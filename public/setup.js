const state = { candidates: [], selectedRoots: new Set(), currentStep: 1 };

const el = {
  refreshButton: document.querySelector("#refreshButton"),
  lastChecked: document.querySelector("#lastChecked"),
  setupError: document.querySelector("#setupError"),
  environmentStatus: document.querySelector("#environmentStatus"),
  environmentChecks: document.querySelector("#environmentChecks"),
  macServiceAction: document.querySelector("#macServiceAction"),
  macServiceGuide: document.querySelector("#macServiceGuide"),
  macServiceButton: document.querySelector("#macServiceButton"),
  projectsStatus: document.querySelector("#projectsStatus"),
  configStatus: document.querySelector("#configStatus"),
  configForm: document.querySelector("#configForm"),
  publicUrlInput: document.querySelector("#publicUrlInput"),
  codexBinInput: document.querySelector("#codexBinInput"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
  environmentNext: document.querySelector("#environmentNext"),
  tunnelNext: document.querySelector("#tunnelNext"),
  projectCandidates: document.querySelector("#projectCandidates"),
  discoverButton: document.querySelector("#discoverButton"),
  saveProjectsButton: document.querySelector("#saveProjectsButton"),
  tunnelStatus: document.querySelector("#tunnelStatus"),
  publicUrl: document.querySelector("#publicUrl"),
  pairStatus: document.querySelector("#pairStatus"),
  pairQr: document.querySelector("#pairQr"),
  pairCode: document.querySelector("#pairCode"),
  pairNotice: document.querySelector("#pairNotice"),
  pairButton: document.querySelector("#pairButton"),
};

el.refreshButton.addEventListener("click", () => void refreshAll());
el.discoverButton.addEventListener("click", () => void discoverProjects());
el.saveProjectsButton.addEventListener("click", () => void saveProjects());
el.pairButton.addEventListener("click", () => void loadPairing());
el.macServiceButton.addEventListener("click", () => void configureMacService());
el.environmentNext.addEventListener("click", () => goToStep(2));
el.tunnelNext.addEventListener("click", () => goToStep(5));
el.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveConfig();
});
for (const button of document.querySelectorAll("[data-step-target]")) {
  button.addEventListener("click", () => goToStep(Number(button.dataset.stepTarget)));
}
for (const button of document.querySelectorAll("[data-step-back]")) {
  button.addEventListener("click", () => goToStep(Number(button.dataset.stepBack)));
}
void refreshAll();

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body;
}

async function refreshAll() {
  setError("");
  setStep(el.environmentStatus, "检查中", "pending");
  setStep(el.projectsStatus, "检查中", "pending");
  setStep(el.tunnelStatus, "检查中", "pending");
  try {
    const status = await request("/api/setup/status");
    await loadConfig();
    renderStatus(status);
    await discoverProjects(true);
  } catch (error) {
    setError(error.message);
    setStep(el.environmentStatus, "无法检查", "error");
  } finally {
    el.lastChecked.textContent = `最近检查：${new Date().toLocaleTimeString()}`;
  }
}

async function loadConfig() {
  const config = await request("/api/setup/config");
  el.publicUrlInput.value = config.publicUrl ?? "";
  el.codexBinInput.value = config.codexBin ?? "codex";
  setStep(el.configStatus, "已读取", "ok");
}

async function saveConfig() {
  el.saveConfigButton.disabled = true;
  setError("");
  try {
    const result = await request("/api/setup/config", {
      method: "POST",
      body: JSON.stringify({ publicUrl: el.publicUrlInput.value, codexBin: el.codexBinInput.value }),
    });
    setStep(el.configStatus, result.restartRequired ? "已保存，重启后生效" : "已保存", "ok");
    goToStep(3);
  } catch (error) {
    setError(error.message);
    setStep(el.configStatus, "保存失败", "error");
  } finally {
    el.saveConfigButton.disabled = false;
  }
}

function renderStatus(status) {
  const checks = [
    ["Node.js", true, `运行中 · ${status.platform}`],
    ["Codex app-server", status.appServer?.state === "ready", status.appServer?.detail ?? "未连接"],
    ["项目配置 .env", status.envFile, status.envFile ? "已找到" : "未找到，使用默认配置"],
    ["cloudflared", status.cloudflared, status.cloudflared ? "已安装" : "未安装"],
    ["Tunnel 配置", status.tunnelConfig && status.tunnelCredentials, status.tunnelConfig && status.tunnelCredentials ? "配置和凭据已找到" : "需要 Cloudflare 授权"],
    ["Mac 后台服务", status.serverAgent, status.serverAgent ? "LaunchAgent 已运行" : "尚未由 LaunchAgent 接管"],
    ["Cloudflare 后台服务", status.tunnelAgent, status.tunnelAgent ? "LaunchAgent 已运行" : "尚未由 LaunchAgent 接管"],
  ];
  el.environmentChecks.replaceChildren();
  for (const [label, ok, value] of checks) {
    const row = document.createElement("div");
    row.className = "check-row";
    const name = document.createElement("strong");
    name.textContent = label;
    const detail = document.createElement("span");
    detail.className = `check-value ${ok ? "ok" : "warn"}`;
    detail.textContent = value;
    row.append(name, detail);
    el.environmentChecks.append(row);
  }
  const serviceReady = Boolean(status.serverAgent);
  el.macServiceAction.hidden = serviceReady;
  if (!serviceReady) {
    el.macServiceButton.disabled = false;
    el.macServiceButton.textContent = "自动配置后台服务";
  }
  setStep(el.environmentStatus, checks.every(([, ok]) => ok) ? "已完成" : "需要处理", checks.every(([, ok]) => ok) ? "ok" : "action");
  el.publicUrl.textContent = `公网地址：${status.publicUrl}`;
  const tunnelReady = status.cloudflared && status.tunnelConfig && status.tunnelCredentials && status.tunnelAgent;
  setStep(el.tunnelStatus, tunnelReady ? "已就绪" : "需要操作", tunnelReady ? "ok" : "action");
}

async function configureMacService() {
  el.macServiceButton.disabled = true;
  el.macServiceButton.textContent = "正在生成配置…";
  setError("");
  try {
    const result = await request("/api/setup/macos-service", { method: "POST", body: JSON.stringify({}) });
    el.macServiceGuide.textContent = `${result.nextStep} 当前终端服务不要与后台服务同时运行。`;
    el.macServiceButton.textContent = "配置已生成";
  } catch (error) {
    setError(error.message);
    el.macServiceButton.disabled = false;
    el.macServiceButton.textContent = "自动配置后台服务";
  }
}

async function discoverProjects(silent = false) {
  if (!silent) setError("");
  el.discoverButton.disabled = true;
  try {
    const result = await request("/api/admin/project-candidates");
    state.candidates = result.candidates ?? [];
    state.selectedRoots = new Set(state.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.cwd));
    renderCandidates();
    setStep(el.projectsStatus, state.candidates.length ? "请选择并保存" : "未找到项目", state.candidates.length ? "action" : "error");
  } catch (error) {
    if (!silent) setError(error.message);
    setStep(el.projectsStatus, "无法读取", "error");
  } finally {
    el.discoverButton.disabled = false;
  }
}

function renderCandidates() {
  el.projectCandidates.replaceChildren();
  if (state.candidates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "没有发现可用的 Codex 项目。";
    el.projectCandidates.append(empty);
    el.saveProjectsButton.disabled = true;
    return;
  }
  for (const candidate of state.candidates) {
    const label = document.createElement("label");
    label.className = "project-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedRoots.has(candidate.cwd);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedRoots.add(candidate.cwd);
      else state.selectedRoots.delete(candidate.cwd);
      el.saveProjectsButton.disabled = state.selectedRoots.size === 0;
    });
    const copy = document.createElement("span");
    copy.className = "project-copy";
    const name = document.createElement("strong");
    name.textContent = `${candidate.name} · ${candidate.threadCount} 个历史任务`;
    const path = document.createElement("small");
    path.textContent = candidate.cwd;
    copy.append(name, path);
    label.append(checkbox, copy);
    el.projectCandidates.append(label);
  }
  el.saveProjectsButton.disabled = state.selectedRoots.size === 0;
}

async function saveProjects() {
  if (state.selectedRoots.size === 0) return;
  el.saveProjectsButton.disabled = true;
  try {
    await request("/api/admin/projects", { method: "POST", body: JSON.stringify({ roots: [...state.selectedRoots] }) });
    setStep(el.projectsStatus, "已保存", "ok");
    await discoverProjects(true);
    setStep(el.projectsStatus, "已保存", "ok");
    goToStep(4);
  } catch (error) {
    setError(error.message);
    el.saveProjectsButton.disabled = false;
  }
}

async function loadPairing() {
  el.pairButton.disabled = true;
  try {
    const result = await request("/api/bootstrap");
    el.pairQr.src = result.qrDataUrl;
    el.pairQr.hidden = false;
    el.pairCode.textContent = `配对码：${result.pairingCode}`;
    el.pairNotice.textContent = result.publicReachable ? "用手机扫描二维码，或输入配对码完成授权。" : "PUBLIC_URL 仍是本机地址，请先配置公网 HTTPS 地址。";
    setStep(el.pairStatus, result.publicReachable ? "可配对" : "需配置 HTTPS", result.publicReachable ? "ok" : "action");
  } catch (error) {
    setError(error.message);
    setStep(el.pairStatus, "生成失败", "error");
  } finally {
    el.pairButton.disabled = false;
  }
}

function setStep(node, text, kind) {
  node.textContent = text;
  node.className = `step-status ${kind}`;
}

function goToStep(step) {
  if (!Number.isInteger(step) || step < 1 || step > 5) return;
  state.currentStep = step;
  for (const card of document.querySelectorAll(".wizard-step[data-step]")) {
    card.classList.toggle("active", Number(card.dataset.step) === step);
  }
  for (const button of document.querySelectorAll("[data-step-target]")) {
    const target = Number(button.dataset.stepTarget);
    button.classList.toggle("active", target === step);
    button.classList.toggle("complete", target < step);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setError(message) {
  el.setupError.textContent = message;
  el.setupError.hidden = !message;
}
