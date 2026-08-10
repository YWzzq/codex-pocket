const state = {
  session: null,
  projects: [],
  projectRoots: [],
  projectCandidates: [],
  models: [],
  model: "",
  effort: "",
  serviceTier: "",
  threads: [],
  selectedId: null,
  timelines: new Map(),
  approvals: [],
  sessions: [],
  socket: null,
  reconnectTimer: null,
  sendPending: false,
  notificationPermission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
};

const el = {
  pairView: document.querySelector("#pairView"),
  pairHint: document.querySelector("#pairHint"),
  pairForm: document.querySelector("#pairForm"),
  pairCode: document.querySelector("#pairCode"),
  pairError: document.querySelector("#pairError"),
  localPairing: document.querySelector("#localPairing"),
  pairQr: document.querySelector("#pairQr"),
  localPairCode: document.querySelector("#localPairCode"),
  localPairNotice: document.querySelector("#localPairNotice"),
  workspaceView: document.querySelector("#workspaceView"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionLabel: document.querySelector("#connectionLabel"),
  hostName: document.querySelector("#hostName"),
  logoutButton: document.querySelector("#logoutButton"),
  pairButton: document.querySelector("#pairButton"),
  projectButton: document.querySelector("#projectButton"),
  sessionButton: document.querySelector("#sessionButton"),
  notificationButton: document.querySelector("#notificationButton"),
  projectDialog: document.querySelector("#projectDialog"),
  projectForm: document.querySelector("#projectForm"),
  projectPathInput: document.querySelector("#projectPathInput"),
  projectError: document.querySelector("#projectError"),
  projectCandidateList: document.querySelector("#projectCandidateList"),
  refreshCandidatesButton: document.querySelector("#refreshCandidatesButton"),
  projectRootList: document.querySelector("#projectRootList"),
  saveProjectsButton: document.querySelector("#saveProjectsButton"),
  sessionDialog: document.querySelector("#sessionDialog"),
  sessionCount: document.querySelector("#sessionCount"),
  sessionList: document.querySelector("#sessionList"),
  revokeAllButton: document.querySelector("#revokeAllButton"),
  pairDialog: document.querySelector("#pairDialog"),
  workspacePairQr: document.querySelector("#workspacePairQr"),
  workspacePairCode: document.querySelector("#workspacePairCode"),
  workspacePairNotice: document.querySelector("#workspacePairNotice"),
  projectSelect: document.querySelector("#projectSelect"),
  modelSelect: document.querySelector("#modelSelect"),
  reasoningSelect: document.querySelector("#reasoningSelect"),
  serviceTierSelect: document.querySelector("#serviceTierSelect"),
  taskHeading: document.querySelector("#taskHeading"),
  newTaskButton: document.querySelector("#newTaskButton"),
  taskList: document.querySelector("#taskList"),
  detailView: document.querySelector("#detailView"),
  backButton: document.querySelector("#backButton"),
  interruptButton: document.querySelector("#interruptButton"),
  retryButton: document.querySelector("#retryButton"),
  releaseButton: document.querySelector("#releaseButton"),
  detailTitle: document.querySelector("#detailTitle"),
  detailMeta: document.querySelector("#detailMeta"),
  detailWriter: document.querySelector("#detailWriter"),
  detailStatus: document.querySelector("#detailStatus"),
  timeline: document.querySelector("#timeline"),
  composer: document.querySelector("#composer"),
  promptInput: document.querySelector("#promptInput"),
  composerContext: document.querySelector("#composerContext"),
  sendButton: document.querySelector("#sendButton"),
  deviceButton: document.querySelector("#deviceButton"),
  approvalSheet: document.querySelector("#approvalSheet"),
  approvalTitle: document.querySelector("#approvalTitle"),
  approvalReason: document.querySelector("#approvalReason"),
  approvalCommand: document.querySelector("#approvalCommand"),
  approvalPath: document.querySelector("#approvalPath"),
  approvalAllow: document.querySelector("#approvalAllow"),
  approvalDeny: document.querySelector("#approvalDeny"),
  approvalStop: document.querySelector("#approvalStop"),
  toast: document.querySelector("#toast"),
};

void boot();
void registerServiceWorker();

el.pairButton.hidden = !isLocalBrowser();
el.projectButton.hidden = !isLocalBrowser();
el.sessionButton.hidden = el.pairButton.hidden;

el.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = el.pairCode.value.trim();
  if (!code) return;
  await pair({ code });
});

el.pairCode.addEventListener("input", () => {
  el.pairCode.value = el.pairCode.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
});

el.modelSelect.addEventListener("change", () => {
  state.model = el.modelSelect.value;
  const model = selectedModel();
  state.effort = model?.defaultReasoningEffort ?? "";
  state.serviceTier = "";
  renderModelSettings();
});

el.reasoningSelect.addEventListener("change", () => {
  state.effort = el.reasoningSelect.value;
});

el.serviceTierSelect.addEventListener("change", () => {
  state.serviceTier = el.serviceTierSelect.value;
});

el.logoutButton.addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST" });
  } finally {
    resetToPairing();
  }
});

el.pairButton.addEventListener("click", () => void showPairDialog());
for (const closeButton of el.pairDialog.querySelectorAll("[data-close-pair]")) {
  closeButton.addEventListener("click", () => {
    el.pairDialog.hidden = true;
  });
}

el.projectButton.addEventListener("click", () => void showProjectDialog());
for (const closeButton of el.projectDialog.querySelectorAll("[data-close-projects]")) {
  closeButton.addEventListener("click", () => {
    el.projectDialog.hidden = true;
  });
}
el.projectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addProjectRoot();
});
el.refreshCandidatesButton.addEventListener("click", () => void loadProjectCandidates());
el.saveProjectsButton.addEventListener("click", () => void saveProjectRoots());

el.sessionButton.addEventListener("click", () => void showSessionDialog());
for (const closeButton of el.sessionDialog.querySelectorAll("[data-close-sessions]")) {
  closeButton.addEventListener("click", () => {
    el.sessionDialog.hidden = true;
  });
}
el.revokeAllButton.addEventListener("click", () => void revokeAllSessions());

el.newTaskButton.addEventListener("click", () => {
  state.selectedId = null;
  renderWorkspace();
  el.promptInput.focus();
});

el.backButton.addEventListener("click", () => {
  state.selectedId = null;
  renderWorkspace();
});

el.interruptButton.addEventListener("click", async () => {
  const thread = selectedThread();
  if (!thread) return;
  try {
    el.interruptButton.disabled = true;
    await request(`/api/threads/${encodeURIComponent(thread.id)}/interrupt`, { method: "POST" });
    showToast("已请求停止任务");
  } catch (error) {
    showToast(error.message);
  } finally {
    el.interruptButton.disabled = false;
  }
});

el.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = el.promptInput.value.trim();
  if (!prompt || state.sendPending) return;
  await sendPrompt(prompt);
});

el.deviceButton.addEventListener("click", () => {
  if (el.sessionButton.hidden) {
    const detail = state.session?.appServer?.detail ?? "正在检查本机 Codex";
    showToast(`${state.session?.host ?? "本地电脑"}: ${detail}`);
    return;
  }
  void showSessionDialog();
});

el.notificationButton.addEventListener("click", () => void enableNotifications());
el.retryButton.addEventListener("click", () => void retryThread());
el.releaseButton.addEventListener("click", () => void releaseThread());

el.approvalAllow.addEventListener("click", () => resolveApproval("allow"));
el.approvalDeny.addEventListener("click", () => resolveApproval("deny"));
el.approvalStop.addEventListener("click", () => resolveApproval("stop"));

async function boot() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("pair");
  if (token) {
    try {
      await pair({ token }, false);
      url.searchParams.delete("pair");
      window.history.replaceState({}, "", url);
    } catch (error) {
      showPairing(error.message);
      return;
    }
  }

  try {
    await loadWorkspace();
  } catch (error) {
    if (error.status === 401 && isLocalBrowser()) {
      try {
        await request("/api/local-session", { method: "POST" });
        await loadWorkspace();
        return;
      } catch (localError) {
        showPairing(localError.message);
        return;
      }
    }
    showPairing(error.status === 401 ? "输入电脑上显示的配对码。" : error.message);
  }
}

function isLocalBrowser() {
  return ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
}

async function pair(payload, loadAfter = true) {
  el.pairError.textContent = "";
  try {
    await request("/api/pair", { method: "POST", body: payload });
    if (loadAfter) await loadWorkspace();
  } catch (error) {
    el.pairError.textContent = error.message;
    throw error;
  }
}

function showPairing(message) {
  closeSocket();
  el.workspaceView.hidden = true;
  el.pairView.hidden = false;
  el.pairHint.textContent = message;
  el.pairError.textContent = "";
  void showLocalPairing();
}

async function showLocalPairing() {
  try {
    const setup = await request("/api/bootstrap");
    el.localPairing.hidden = false;
    el.pairQr.src = setup.qrDataUrl;
    el.localPairCode.textContent = `配对码：${setup.pairingCode}`;
    el.localPairNotice.textContent = setup.publicReachable
      ? "扫描二维码即可配对；首次配对后会保持授权，直到你在电脑端撤销。"
      : "先配置 HTTPS 访问地址，再从手机扫描二维码。";
  } catch {
    el.localPairing.hidden = true;
  }
}

async function showPairDialog() {
  el.pairDialog.hidden = false;
  el.workspacePairCode.textContent = "正在生成配对码…";
  try {
    const setup = await request("/api/bootstrap");
    el.workspacePairQr.src = setup.qrDataUrl;
    el.workspacePairCode.textContent = `配对码：${setup.pairingCode}`;
    el.workspacePairNotice.textContent = setup.publicReachable
      ? "二维码有效期五分钟；首次配对后会保持授权，直到你在电脑端撤销。"
      : "配置 HTTPS 访问地址后，手机才能通过二维码连接。";
  } catch (error) {
    el.workspacePairCode.textContent = "无法生成配对码";
    el.workspacePairNotice.textContent = error.message;
  }
}

async function showProjectDialog() {
  el.projectDialog.hidden = false;
  el.projectError.textContent = "";
  el.projectPathInput.value = "";
  try {
    const data = await request("/api/admin/projects");
    state.projectRoots = (data.projects ?? []).map((project) => project.cwd);
    renderProjectRoots();
    await loadProjectCandidates();
  } catch (error) {
    el.projectError.textContent = error.message;
  }
}

async function loadProjectCandidates() {
  el.refreshCandidatesButton.disabled = true;
  try {
    const data = await request("/api/admin/project-candidates");
    state.projectCandidates = data.candidates ?? [];
    renderProjectCandidates();
  } catch (error) {
    el.projectError.textContent = error.message;
  } finally {
    el.refreshCandidatesButton.disabled = false;
  }
}

function renderProjectCandidates() {
  el.projectCandidateList.replaceChildren();
  if (state.projectCandidates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "当前扫描目录没有发现可选项目。";
    el.projectCandidateList.append(empty);
    return;
  }
  for (const candidate of state.projectCandidates) {
    const label = document.createElement("label");
    label.className = "project-candidate-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.projectRoots.includes(candidate.cwd);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.projectRoots.push(candidate.cwd);
      else state.projectRoots = state.projectRoots.filter((root) => root !== candidate.cwd);
      state.projectRoots = [...new Set(state.projectRoots)];
      renderProjectRoots();
    });
    const copy = document.createElement("span");
    copy.className = "project-candidate-copy";
    const name = document.createElement("strong");
    name.textContent = candidate.name;
    const pathText = document.createElement("small");
    const threadCount = Number(candidate.threadCount ?? 0);
    pathText.textContent = `${threadCount} 条历史对话 · ${candidate.cwd}`;
    copy.append(name, pathText);
    if (candidate.sampleTitle) {
      const sample = document.createElement("small");
      sample.textContent = `最近：${candidate.sampleTitle}`;
      copy.append(sample);
    }
    label.append(checkbox, copy);
    el.projectCandidateList.append(label);
  }
}

function renderProjectRoots() {
  el.projectRootList.replaceChildren();
  for (const root of state.projectRoots) {
    const row = document.createElement("div");
    row.className = "project-root-row";
    const pathText = document.createElement("code");
    pathText.textContent = root;
    const remove = document.createElement("button");
    remove.className = "button secondary compact";
    remove.type = "button";
    remove.textContent = "移除";
    remove.disabled = state.projectRoots.length <= 1;
    remove.addEventListener("click", () => {
      state.projectRoots = state.projectRoots.filter((entry) => entry !== root);
      renderProjectRoots();
    });
    row.append(pathText, remove);
    el.projectRootList.append(row);
  }
  if (state.projectRoots.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "至少保留一个项目目录。";
    el.projectRootList.append(empty);
  }
  if (state.projectCandidates.length > 0) renderProjectCandidates();
}

function addProjectRoot() {
  const root = el.projectPathInput.value.trim();
  el.projectError.textContent = "";
  if (!root) return;
  if (!root.startsWith("/")) {
    el.projectError.textContent = "请输入绝对路径，例如 /Users/你的用户名/项目。";
    return;
  }
  if (state.projectRoots.includes(root)) {
    el.projectError.textContent = "这个目录已经在允许列表中。";
    return;
  }
  state.projectRoots.push(root);
  el.projectPathInput.value = "";
  renderProjectRoots();
}

async function saveProjectRoots() {
  el.projectError.textContent = "";
  try {
    el.saveProjectsButton.disabled = true;
    const data = await request("/api/admin/projects", {
      method: "POST",
      body: { roots: state.projectRoots },
    });
    state.projectRoots = (data.projects ?? []).map((project) => project.cwd);
    el.projectDialog.hidden = true;
    await loadWorkspace();
    showToast("项目设置已保存");
  } catch (error) {
    el.projectError.textContent = error.message;
  } finally {
    el.saveProjectsButton.disabled = false;
  }
}

async function showSessionDialog() {
  el.sessionDialog.hidden = false;
  el.sessionList.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "empty-state";
  loading.textContent = "正在读取连接…";
  el.sessionList.append(loading);
  try {
    const data = await request("/api/admin/sessions");
    state.sessions = data.sessions ?? [];
    renderSessions();
  } catch (error) {
    el.sessionList.replaceChildren();
    const failure = document.createElement("p");
    failure.className = "empty-state";
    failure.textContent = error.message;
    el.sessionList.append(failure);
  }
}

function renderSessions() {
  const sessions = state.sessions;
  el.sessionCount.textContent = `${sessions.length} 个已授权设备`;
  el.revokeAllButton.disabled = sessions.every((session) => session.current);
  el.sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "当前没有已授权的设备。";
    el.sessionList.append(empty);
    return;
  }
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const copy = document.createElement("div");
    copy.className = "session-copy";
    const title = document.createElement("strong");
    title.textContent = session.current ? `${session.device}（当前电脑）` : session.device;
    const meta = document.createElement("span");
    meta.textContent = `${session.active ? "在线" : "已授权 · 当前未连接"} · 最近活动：${formatSessionTime(session.lastSeenAt)} · 授权于 ${formatSessionTime(session.createdAt)}`;
    copy.append(title, meta);
    const revoke = document.createElement("button");
    revoke.className = "button secondary compact";
    revoke.type = "button";
    revoke.textContent = session.current ? "当前会话" : "撤销授权";
    revoke.disabled = session.current;
    revoke.addEventListener("click", () => void revokeSession(session));
    row.append(copy, revoke);
    el.sessionList.append(row);
  }
}

async function revokeSession(session) {
  if (!window.confirm(`确定撤销“${session.device}”的授权吗？`)) return;
  try {
    await request(`/api/admin/sessions/${encodeURIComponent(session.id)}/revoke`, { method: "POST" });
    await showSessionDialog();
  } catch (error) {
    showToast(error.message);
  }
}

async function revokeAllSessions() {
  if (!window.confirm("确定撤销其他所有手机和浏览器的授权吗？")) return;
  try {
    await request("/api/admin/sessions/revoke-all", { method: "POST" });
    await showSessionDialog();
  } catch (error) {
    showToast(error.message);
  }
}

function formatSessionTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function loadWorkspace() {
  const session = await request("/api/session");
  state.session = session;
  state.projects = session.projects ?? [];
  state.projectRoots = state.projects.map((project) => project.cwd);
  state.approvals = session.approvals ?? [];
  const modelData = await request("/api/models").catch(() => ({ models: [] }));
  state.models = modelData.models ?? [];
  initializeModelSettings();
  const threadData = await request("/api/threads");
  state.threads = threadData.threads ?? [];
  el.pairView.hidden = true;
  el.workspaceView.hidden = false;
  renderWorkspace();
  connectSocket();
}

function resetToPairing() {
  state.session = null;
  state.projects = [];
  state.projectRoots = [];
  state.projectCandidates = [];
  state.models = [];
  state.model = "";
  state.effort = "";
  state.serviceTier = "";
  state.threads = [];
  state.selectedId = null;
  state.timelines.clear();
  state.approvals = [];
  showPairing("此浏览器已断开连接。");
}

function renderWorkspace() {
  renderConnection();
  renderProjects();
  renderModelSettings();
  renderTaskList();
  renderDetail();
  renderComposer();
  renderApproval();
  renderNotificationButton();
}

function initializeModelSettings() {
  const defaultModel = state.models.find((model) => model.isDefault) ?? state.models[0];
  if (!state.models.some((model) => model.id === state.model)) state.model = defaultModel?.id ?? "";
  const model = selectedModel();
  const supportedEfforts = model?.supportedReasoningEfforts ?? [];
  if (!supportedEfforts.some((effort) => effort.id === state.effort)) state.effort = model?.defaultReasoningEffort ?? supportedEfforts[0]?.id ?? "";
  const supportedTiers = model?.serviceTiers ?? [];
  if (!supportedTiers.some((tier) => tier.id === state.serviceTier)) state.serviceTier = "";
}

function selectedModel() {
  return state.models.find((model) => model.id === state.model) ?? null;
}

function renderModelSettings() {
  const model = selectedModel();
  const locked = Boolean(selectedThread());
  el.modelSelect.replaceChildren();
  for (const entry of state.models) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.displayName;
    option.title = entry.description;
    el.modelSelect.append(option);
  }
  el.modelSelect.value = state.model;
  el.modelSelect.disabled = locked || state.models.length === 0;

  el.reasoningSelect.replaceChildren();
  const defaultReasoning = document.createElement("option");
  defaultReasoning.value = "";
  defaultReasoning.textContent = "默认";
  el.reasoningSelect.append(defaultReasoning);
  for (const effort of model?.supportedReasoningEfforts ?? []) {
    const option = document.createElement("option");
    option.value = effort.id;
    option.textContent = effort.id === model.defaultReasoningEffort ? `${effort.id}（默认）` : effort.id;
    option.title = effort.description;
    el.reasoningSelect.append(option);
  }
  el.reasoningSelect.value = state.effort;
  el.reasoningSelect.disabled = locked || !model || (model.supportedReasoningEfforts ?? []).length === 0;

  el.serviceTierSelect.replaceChildren();
  const defaultTier = document.createElement("option");
  defaultTier.value = "";
  defaultTier.textContent = "默认速度";
  el.serviceTierSelect.append(defaultTier);
  for (const tier of model?.serviceTiers ?? []) {
    const option = document.createElement("option");
    option.value = tier.id;
    option.textContent = tier.name;
    option.title = tier.description;
    el.serviceTierSelect.append(option);
  }
  el.serviceTierSelect.value = state.serviceTier;
  el.serviceTierSelect.disabled = locked || !model || (model.serviceTiers ?? []).length === 0;
}

function renderConnection() {
  const appServer = state.session?.appServer;
  const ready = appServer?.state === "ready";
  el.hostName.textContent = state.session?.host ?? "本地电脑";
  el.connectionLabel.textContent = ready ? "本地 Codex 已连接" : appServer?.detail ?? "本地 Codex 未连接";
  el.connectionDot.className = `status-dot ${ready ? "ready" : "offline"}`;
}

function renderProjects() {
  const selected = el.projectSelect.value || state.projects[0]?.id || "";
  el.projectSelect.replaceChildren();
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    el.projectSelect.append(option);
  }
  el.projectSelect.value = state.projects.some((project) => project.id === selected) ? selected : state.projects[0]?.id ?? "";
  el.projectSelect.onchange = () => renderComposer();
}

function renderTaskList() {
  const hasSelection = Boolean(selectedThread());
  el.taskList.hidden = hasSelection;
  el.taskHeading.textContent = hasSelection ? "任务详情" : "项目任务";
  if (hasSelection) return;

  el.taskList.replaceChildren();
  if (state.threads.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有任务。选择项目后发出第一条指令。";
    el.taskList.append(empty);
    return;
  }

  const groups = new Map();
  for (const thread of state.threads) {
    const projectId = thread.projectId ?? "__unknown__";
    const group = groups.get(projectId) ?? { projectId, threads: [] };
    group.threads.push(thread);
    groups.set(projectId, group);
  }

  const sortedGroups = [...groups.values()].sort((a, b) => {
    const latestA = Math.max(...a.threads.map((thread) => Number(thread.updatedAt) || 0));
    const latestB = Math.max(...b.threads.map((thread) => Number(thread.updatedAt) || 0));
    return latestB - latestA;
  });

  for (const group of sortedGroups) {
    group.threads.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    const section = document.createElement("section");
    section.className = "project-task-group";
    section.setAttribute("aria-labelledby", `project-task-group-${group.projectId}`);

    const header = document.createElement("header");
    header.className = "project-task-group-header";
    const title = document.createElement("strong");
    title.id = `project-task-group-${group.projectId}`;
    title.className = "project-task-group-title";
    title.textContent = projectName(group.projectId);
    const activeCount = group.threads.filter((thread) => isActiveTask(thread.status)).length;
    const meta = document.createElement("span");
    meta.className = "project-task-group-meta";
    meta.textContent = `${group.threads.length} 个任务${activeCount ? ` · ${activeCount} 个进行中` : ""}`;
    header.append(title, meta);

    const items = document.createElement("div");
    items.className = "project-task-items";
    for (const thread of group.threads) {
      items.append(createTaskRow(thread));
    }
    section.append(header, items);
    el.taskList.append(section);
  }
}

function createTaskRow(thread) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "task-row";
  row.addEventListener("click", () => void selectThread(thread.id));

  const dot = document.createElement("span");
  dot.className = `status-dot ${dotClass(thread.status)}`;
  const copy = document.createElement("span");
  copy.className = "task-row-copy";
  const title = document.createElement("span");
  title.className = "task-row-title";
  title.textContent = thread.title;
  const meta = document.createElement("span");
  meta.className = "task-row-meta";
  meta.textContent = thread.writer
    ? `${relativeTime(thread.updatedAt)} · 占用：${thread.writer.device}`
    : relativeTime(thread.updatedAt);
  copy.append(title, meta);
  const status = document.createElement("span");
  status.className = `status-label ${thread.status}`;
  status.textContent = statusLabel(thread.status);
  row.append(dot, copy, status);
  return row;
}

function renderDetail() {
  const thread = selectedThread();
  el.detailView.hidden = !thread;
  if (!thread) return;
  el.detailTitle.textContent = thread.title;
  el.detailMeta.textContent = `${projectName(thread.projectId)} · ${thread.cwd}`;
  el.detailStatus.className = `status-label ${thread.status}`;
  el.detailStatus.textContent = statusLabel(thread.status);
  el.interruptButton.hidden = !["running", "starting", "approval", "stopping"].includes(thread.status);
  el.retryButton.hidden = !["failed", "interrupted"].includes(thread.status);
  el.releaseButton.hidden = !thread.writer;
  el.releaseButton.textContent = isActiveTask(thread.status) ? "停止并释放" : "释放占用";
  el.detailWriter.hidden = !thread.writer;
  el.detailWriter.textContent = thread.writer ? `当前占用设备：${thread.writer.device} · ${relativeTime(thread.writer.startedAt)}开始` : "";
  renderTimeline(thread.id);
}

function renderTimeline(threadId) {
  const timeline = state.timelines.get(threadId) ?? [];
  el.timeline.replaceChildren();
  if (timeline.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "正在读取任务记录…";
    el.timeline.append(empty);
    return;
  }
  for (const entry of timeline) {
    const node = document.createElement(entry.type === "output" ? "pre" : "div");
    if (entry.type === "message") {
      node.className = `timeline-message ${entry.role}`;
      node.textContent = entry.text;
    } else if (entry.type === "output") {
      node.className = "timeline-output";
      node.textContent = entry.text;
    } else {
      node.className = "timeline-activity";
      node.textContent = entry.label ?? entry.message ?? "任务状态已更新";
    }
    el.timeline.append(node);
  }
  el.timeline.lastElementChild?.scrollIntoView({ block: "nearest" });
}

function renderComposer() {
  const thread = selectedThread();
  const threadBusy = Boolean(thread && isActiveTask(thread.status));
  el.composerContext.textContent = threadBusy
    ? `${projectName(thread.projectId)} · 任务执行中，完成后可继续`
    : thread
      ? `${projectName(thread.projectId)} · 继续当前任务`
      : `${selectedProject()?.name ?? "未选择项目"} · 开始新任务`;
  el.sendButton.disabled = state.sendPending || threadBusy || state.projects.length === 0;
  el.promptInput.disabled = state.sendPending || threadBusy;
}

function renderApproval() {
  const approval = state.approvals[0];
  el.approvalSheet.hidden = !approval;
  if (!approval) return;
  const isPermissionRequest = approval.method === "item/permissions/requestApproval";
  el.approvalTitle.textContent = isPermissionRequest ? "Codex 请求更多权限" : "Codex 想在电脑上执行操作";
  el.approvalReason.textContent = approval.reason || (isPermissionRequest ? "该任务请求超出既有限制的权限。" : "该操作需要你的确认。") ;
  el.approvalCommand.textContent = approval.command || (isPermissionRequest ? JSON.stringify(approval.permissions, null, 2) : "未提供命令详情");
  el.approvalPath.textContent = approval.cwd ? `目录：${approval.cwd}` : "";
  el.approvalAllow.textContent = isPermissionRequest ? "保持限制" : "仅本次允许";
  el.approvalAllow.dataset.action = isPermissionRequest ? "keep_restricted" : "allow";
  el.approvalDeny.hidden = isPermissionRequest;
}

async function selectThread(threadId) {
  state.selectedId = threadId;
  renderWorkspace();
  try {
    const data = await request(`/api/threads/${encodeURIComponent(threadId)}`);
    if (state.selectedId !== threadId) return;
    state.timelines.set(threadId, normalizeTimeline(data.history?.timeline));
    renderWorkspace();
  } catch (error) {
    if (state.selectedId === threadId) showToast(error.message);
  }
}

async function sendPrompt(prompt) {
  const selected = selectedThread();
  const project = selectedProject();
  if (!selected && !project) {
    showToast("先选择一个项目");
    return;
  }
  if (selected && isActiveTask(selected.status)) {
    showToast("这个任务正在执行，请等待完成后再发送。");
    return;
  }
  state.sendPending = true;
  renderComposer();
  try {
    let result;
    if (selected) {
      result = await request(`/api/threads/${encodeURIComponent(selected.id)}/messages`, { method: "POST", body: { prompt } });
      appendTimeline(selected.id, { type: "message", role: "user", text: prompt, at: Date.now() });
      upsertThread(result.thread);
    } else {
      result = await request("/api/threads", { method: "POST", body: { projectId: project.id, prompt, settings: selectedSettings() } });
      upsertThread(result.thread);
      state.selectedId = result.thread.id;
      state.timelines.set(result.thread.id, [{ type: "message", role: "user", text: prompt, at: Date.now() }]);
    }
    el.promptInput.value = "";
    renderWorkspace();
  } catch (error) {
    showToast(error.message);
  } finally {
    state.sendPending = false;
    renderComposer();
  }
}

async function retryThread() {
  const thread = selectedThread();
  if (!thread || !["failed", "interrupted"].includes(thread.status)) return;
  try {
    el.retryButton.disabled = true;
    const result = await request(`/api/threads/${encodeURIComponent(thread.id)}/retry`, { method: "POST" });
    appendTimeline(thread.id, { type: "message", role: "user", text: `重试：${result.prompt}`, at: Date.now() });
    upsertThread(result.thread);
    renderWorkspace();
  } catch (error) {
    showToast(error.message);
  } finally {
    el.retryButton.disabled = false;
  }
}

async function releaseThread() {
  const thread = selectedThread();
  if (!thread?.writer) return;
  try {
    el.releaseButton.disabled = true;
    const result = await request(`/api/threads/${encodeURIComponent(thread.id)}/release`, { method: "POST" });
    if (result.thread) upsertThread(result.thread);
    renderWorkspace();
    showToast(result.status === "stopping" ? "已请求停止并释放任务" : "已释放本地占用");
  } catch (error) {
    showToast(error.message);
  } finally {
    el.releaseButton.disabled = false;
  }
}

function selectedSettings() {
  return {
    ...(state.model ? { model: state.model } : {}),
    ...(state.effort ? { effort: state.effort } : {}),
    ...(state.serviceTier ? { serviceTier: state.serviceTier } : {}),
  };
}

async function resolveApproval(action) {
  const approval = state.approvals[0];
  if (!approval) return;
  const effectiveAction = action === "allow" ? el.approvalAllow.dataset.action : action;
  try {
    setApprovalButtons(true);
    await request(`/api/approvals/${encodeURIComponent(approval.id)}`, { method: "POST", body: { action: effectiveAction } });
    state.approvals = state.approvals.filter((entry) => entry.id !== approval.id);
    renderApproval();
  } catch (error) {
    showToast(error.message);
  } finally {
    setApprovalButtons(false);
  }
}

function setApprovalButtons(disabled) {
  el.approvalAllow.disabled = disabled;
  el.approvalDeny.disabled = disabled;
  el.approvalStop.disabled = disabled;
}

function connectSocket() {
  closeSocket();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("message", (event) => {
    try {
      handleSocketEvent(JSON.parse(event.data));
    } catch {
      // Ignore malformed transient events instead of breaking the task view.
    }
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket && state.session) {
      updateAppServer({ state: "offline", detail: "与本地控制台的连接已断开" });
      state.reconnectTimer = window.setTimeout(connectSocket, 2_000);
    }
  });
  socket.addEventListener("error", () => socket.close());
}

function closeSocket() {
  window.clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

function handleSocketEvent(event) {
  if (event.type === "snapshot") {
    state.threads = event.threads ?? state.threads;
    state.approvals = event.approvals ?? state.approvals;
    updateAppServer(event.appServer);
    renderWorkspace();
    return;
  }
  if (event.type === "app_server") {
    updateAppServer(event.appServer);
    renderWorkspace();
    return;
  }
  if (event.type === "thread_updated") {
    const previous = state.threads.find((thread) => thread.id === event.thread?.id);
    notifyTaskUpdate(event.thread, previous);
    upsertThread(event.thread);
    renderWorkspace();
    return;
  }
  if (event.type === "approval_requested") {
    state.approvals = [event.approval, ...state.approvals.filter((entry) => entry.id !== event.approval.id)];
    notifyTaskUpdate(state.threads.find((thread) => thread.id === event.approval.threadId), null, "approval");
    renderWorkspace();
    return;
  }
  if (event.type === "approval_resolved") {
    state.approvals = state.approvals.filter((approval) => approval.id !== event.approvalId);
    renderWorkspace();
    return;
  }
  if (!event.threadId) return;
  if (event.type === "agent_delta") {
    appendDelta(event.threadId, event.itemId, "message", "assistant", event.delta);
  } else if (event.type === "command_output") {
    appendDelta(event.threadId, event.itemId, "output", null, event.delta);
  } else if (event.type === "activity") {
    upsertActivity(event.threadId, event);
  } else if (event.type === "error") {
    appendTimeline(event.threadId, { type: "activity", label: event.message, at: event.at });
  }
  if (state.selectedId === event.threadId) renderWorkspace();
}

function appendDelta(threadId, itemId, type, role, delta) {
  const timeline = state.timelines.get(threadId) ?? [];
  let entry = timeline.find((candidate) => candidate.itemId === itemId);
  if (!entry) {
    entry = { type, role, text: "", itemId, at: Date.now() };
    timeline.push(entry);
  }
  entry.text += delta;
  state.timelines.set(threadId, timeline);
}

function appendTimeline(threadId, entry) {
  const timeline = state.timelines.get(threadId) ?? [];
  timeline.push(entry);
  state.timelines.set(threadId, timeline);
}

function upsertActivity(threadId, event) {
  const timeline = state.timelines.get(threadId) ?? [];
  const existing = event.itemId
    ? timeline.find((entry) => entry.type === "activity" && entry.itemId === event.itemId)
    : null;
  if (existing) {
    existing.label = event.label;
    existing.phase = event.phase;
    existing.at = event.at;
  } else {
    timeline.push({
      type: "activity",
      itemId: event.itemId,
      label: event.label,
      phase: event.phase,
      at: event.at,
    });
  }
  state.timelines.set(threadId, timeline);
}

function normalizeTimeline(timeline) {
  return Array.isArray(timeline) ? timeline.map((entry) => ({ ...entry })) : [];
}

function upsertThread(thread) {
  if (!thread?.id) return;
  const current = state.threads.findIndex((entry) => entry.id === thread.id);
  if (current >= 0) state.threads[current] = { ...state.threads[current], ...thread };
  else state.threads.unshift(thread);
  state.threads.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}

function updateAppServer(appServer) {
  if (!state.session || !appServer) return;
  state.session.appServer = appServer;
}

function selectedThread() {
  return state.threads.find((thread) => thread.id === state.selectedId) ?? null;
}

function selectedProject() {
  return state.projects.find((project) => project.id === el.projectSelect.value) ?? state.projects[0] ?? null;
}

function projectName(projectId) {
  return state.projects.find((project) => project.id === projectId)?.name ?? "本地项目";
}

function statusLabel(status) {
  return {
    starting: "正在启动",
    running: "正在执行",
    approval: "等待批准",
    stopping: "正在停止",
    completed: "已完成",
    interrupted: "已停止",
    failed: "执行失败",
    unknown: "状态未知",
  }[status] ?? "状态未知";
}

function dotClass(status) {
  return ["running", "starting"].includes(status) ? "ready" : status === "failed" ? "offline" : status === "approval" ? "offline" : "";
}

function isActiveTask(status) {
  return ["starting", "running", "approval", "stopping"].includes(status);
}

function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - Number(value));
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)} 小时前`;
  return `${Math.round(elapsed / 86_400_000)} 天前`;
}

function renderNotificationButton() {
  if (state.notificationPermission === "unsupported") {
    el.notificationButton.hidden = true;
    return;
  }
  el.notificationButton.hidden = false;
  el.notificationButton.textContent = state.notificationPermission === "granted" ? "通知已开" : "开启通知";
  el.notificationButton.disabled = state.notificationPermission === "denied";
  el.notificationButton.title = state.notificationPermission === "denied" ? "请在浏览器设置中允许通知" : "任务完成或需要批准时通知";
}

async function enableNotifications() {
  if (state.notificationPermission === "unsupported") return;
  try {
    state.notificationPermission = await Notification.requestPermission();
    renderNotificationButton();
    showToast(state.notificationPermission === "granted" ? "任务通知已开启" : "未开启任务通知");
  } catch {
    showToast("当前浏览器不支持任务通知");
  }
}

function notifyTaskUpdate(thread, previous, forcedStatus = "") {
  if (!thread || state.notificationPermission !== "granted" || document.visibilityState === "visible") return;
  const status = forcedStatus || thread.status;
  if (!forcedStatus && (!previous || previous.status === status)) return;
  const message = status === "approval"
    ? "Codex 正在等待你的批准"
    : status === "completed"
      ? "任务已完成"
      : status === "failed"
        ? "任务执行失败，可点击重试"
        : "任务状态已更新";
  if (!["approval", "completed", "failed"].includes(status)) return;
  let notification;
  try {
    notification = new Notification(thread.title || "Codex Pocket", {
      body: message,
      tag: `codex-pocket-${thread.id}-${status}`,
    });
  } catch {
    return;
  }
  notification.onclick = () => {
    window.focus();
    void selectThread(thread.id);
    notification.close();
  };
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // PWA install is optional; the task console still works without it.
  }
}

async function request(url, options = {}) {
  const init = {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers ?? {}) },
    ...options,
  };
  if (options.body && typeof options.body !== "string") init.body = JSON.stringify(options.body);
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 4_000);
}
