// 普通网页 —— 没有框架，没有构建。standard core 的对话界面。
"use strict";
const $ = (s) => document.querySelector(s);
const msgsEl = $("#msgs");
const input = $("#input");
const sendBtn = $("#send");
let sending = false;

// ---- 会话（多会话）：左侧栏列表（类似壳的 cores 列表），分叉做进消息右键菜单。 ----
// 旧 core 没有 /api/sessions → 侧栏隐藏，按单会话运行（所有请求不带 session，行为与原来一致）。
const sessionSide = $("#sessionSide");
const sessionList = $("#sessionList");
const newSessionBtn = $("#newSession");
const sidesTitle = document.querySelector(".sides-title"); // 点标题折叠/展开（与壳的 cores 侧栏一致）
let currentSession = "default";
const SESSION_KEY = "sessionSel"; // localStorage 按端口（每个 core 独立 origin）记住当前会话
const SIDE_KEY = "sessionSideCollapsed";

// 会话项右键菜单（删除会话；default 也可删，删后作为锚点会在无 session 请求时自动重建）
const sideMenu = document.createElement("div");
sideMenu.className = "actions side-menu";
const sideMenuDel = document.createElement("button");
sideMenuDel.textContent = "删除会话";
sideMenuDel.className = "danger";
sideMenu.append(sideMenuDel);
document.body.append(sideMenu);

function hideSideMenu() {
  sideMenu.classList.remove("show");
}

function showSideMenu(sid, x, y) {
  sideMenu.dataset.id = sid;
  sideMenu.classList.add("show");
  sideMenu.style.left = `${Math.min(x, innerWidth - sideMenu.offsetWidth - 8)}px`;
  sideMenu.style.top = `${Math.min(y, innerHeight - sideMenu.offsetHeight - 8)}px`;
}

sideMenuDel.onclick = async () => {
  hideSideMenu();
  const sid = sideMenu.dataset.id;
  if (!confirm("删除会话？消息留在池中，其他会话不受影响。")) return;
  const r = await api("/api/sessions/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sid }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(`删除失败: ${d.error ?? r.status}`);
    return;
  }
  await refreshSessions("default"); // 切到剩余会话；删光则服务端重建空锚点并自动出现在列表
  load();
};

async function refreshSessions(want) {
  let r = await api("/api/sessions");
  if (!r.ok) return null;
  let list = await r.json();
  if (list.length === 0) {
    // 没有任何会话（删光了）：无 session 请求触发服务端重建 default 锚点，再列一次——列表立即恢复
    await api("/api/messages");
    r = await api("/api/sessions");
    if (!r.ok) return null;
    list = await r.json();
  }
  const cur = list.some((s) => s.id === want) ? want : (list[0]?.id ?? "default");
  currentSession = cur;
  sessionList.textContent = "";
  for (const s of list) {
    const item = document.createElement("div");
    item.className = `side-item${s.id === cur ? " active" : ""}`;
    item.dataset.id = s.id;
    const nm = document.createElement("span");
    nm.className = "si-name";
    nm.textContent = s.name;
    nm.title = `${s.count} 条消息${s.preview ? `\n${s.preview}` : ""}`;
    const cnt = document.createElement("span");
    cnt.className = "si-count";
    cnt.textContent = s.count;
    item.append(nm, cnt);
    item.onclick = () => switchSession(s.id);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      showSideMenu(s.id, e.clientX, e.clientY);
    };
    sessionList.append(item);
  }
  localStorage.setItem(SESSION_KEY, cur);
  return list;
}

function switchSession(id) {
  if (id === currentSession) return;
  currentSession = id;
  for (const el of sessionList.children) el.classList.toggle("active", el.dataset.id === id);
  localStorage.setItem(SESSION_KEY, id);
  load();
  applySessionModel(); // 恢复该会话记过的模型（无记录则保持当前选择）
}

// 切换会话后恢复该会话的 provider/model（服务端按会话存）
async function applySessionModel() {
  if (catalog.length === 0) return;
  const r = await api(`/api/models?session=${encodeURIComponent(currentSession)}`);
  if (!r.ok) return;
  const d = await r.json();
  if (d.current) await applyModel(d.current);
}

async function createSession(name, fork, at) {
  const r = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      ...(fork ? { fork, ...(at != null ? { at } : {}) } : {}),
      settingsFrom: currentSession, // 新会话继承当前会话的 provider/model 设置
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(`${fork ? "分叉" : "新建"}失败: ${d.error ?? r.status}`);
    return null;
  }
  await refreshSessions(d.id);
  load();
  applySessionModel(); // 新会话已继承当前会话的设置（服务端复制），下拉与源会话一致
  return d.id;
}

newSessionBtn.onclick = () => {
  const name = prompt("新会话名称:");
  if (name) createSession(name);
};

// 消息右键菜单"分叉"：从这条消息（含）分叉出新会话
async function forkAt(messageId) {
  const name = prompt("从这条消息分叉为新会话，名称:");
  if (!name) return;
  await createSession(name, currentSession, messageId);
}

// 消息右键菜单"请求"：以这条消息为最后一条重新请求回复，回复插入在其后（后续消息保留）。
// 重新生成模式：不新增用户消息、不依赖输入框，直接请求（LLM 输入的最后一条 = 这条消息）
async function askAt(messageId) {
  send("", messageId, { regen: true });
}

// 消息右键菜单"修改"：copy-on-edit（只改本会话，共享此消息的其他会话不受影响）
async function editAt(messageId) {
  const bubble = document.querySelector(`.msg[data-id="${messageId}"] .bubble`);
  const current = bubble ? bubble.textContent : "";
  const text = prompt("修改这条消息的内容:", current);
  if (text == null || text.trim() === "") return;
  const r = await api("/api/messages/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: messageId, text, session: currentSession }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(`修改失败: ${d.error ?? r.status}`);
    return;
  }
  load();
}
sidesTitle.onclick = () => {
  // 折叠/展开会话栏（折叠后标题占满整条窄 bar，点击任意处展开）
  const collapsed = sessionSide.classList.toggle("collapsed");
  localStorage.setItem(SIDE_KEY, collapsed ? "1" : "0");
};

// 自动滚动跟随：停在底部时新内容自动滚到底；翻到历史前面则暂停跟随，滚回底部恢复。
// （流式输出逐字增长 + done 后整表重绘都会触发滚动——只滚给"在底部看输出"的人。）
let followScroll = true;
const SCROLL_NEAR_BOTTOM = 40; // 距底部多少像素内视为"在底部"
function nearBottom() {
  return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < SCROLL_NEAR_BOTTOM;
}
function autoScroll() {
  if (followScroll) msgsEl.scrollTop = msgsEl.scrollHeight;
}

// daemon 设置 COCKPIT_TOKEN 时，本页的 /api/* 请求也要带同样的令牌（浏览器会话内记住）
let token = sessionStorage.getItem("cockpitToken") || "";
async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  let r = await fetch(path, { ...init, headers });
  if (r.status === 401 && !token) {
    const t = prompt("core 需要访问令牌（daemon 的 COCKPIT_TOKEN）:");
    if (t) {
      token = t;
      sessionStorage.setItem("cockpitToken", t);
      headers.set("authorization", `Bearer ${t}`);
      r = await fetch(path, { ...init, headers });
    }
  }
  return r;
}

// 浏览器标签标题随 core 身份显示：模板是 standard，fork 出的 core（如 default）显示自己的 id
api("/api/status")
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => {
    if (!s || !s.core) return;
    document.title = `${s.core} core · 对话`;
  })
  .catch(() => {});

// 步骤行（role="step"）：JSON → 可折叠卡片（思考/工具调用，含参数与结果）
function stepBox(raw) {
  const det = document.createElement("details");
  det.className = "stepbox";
  let s = null;
  try { s = JSON.parse(raw); } catch {}
  const sum = document.createElement("summary");
  const pre = document.createElement("pre");
  if (s && s.type === "tool") {
    sum.textContent = `工具 · ${s.name}`;
    pre.textContent = `参数: ${s.args ?? ""}${s.result != null ? `\n结果: ${s.result}` : ""}`;
  } else if (s && s.type === "think") {
    sum.textContent = "思考";
    pre.textContent = s.content ?? "";
  } else {
    sum.textContent = "步骤";
    pre.textContent = raw;
  }
  det.append(sum, pre);
  return det;
}

// 右键菜单：消息上的 删除/截断。每条消息的 .actions 就是它的菜单。
function hideMenu() {
  for (const a of document.querySelectorAll(".msg .actions.show")) a.classList.remove("show");
}

function showMenu(msg, x, y) {
  hideMenu();
  const menu = msg.querySelector(".actions");
  menu.classList.add("show");
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}

// 右键任意带 id 的消息行（含步骤卡片的摘要/内容）→ 弹菜单；系统提示/临时气泡没有 id，交回浏览器默认菜单
function openMenuFor(e) {
  const msg = e.target.closest(".msg");
  if (!msg || msg.dataset.id == null) return;
  if (e.target.closest(".actions")) return; // 在菜单上右键不重开
  e.preventDefault();
  showMenu(msg, e.clientX, e.clientY);
}

msgsEl.addEventListener("contextmenu", openMenuFor);

document.addEventListener("click", (e) => {
  if (!e.target.closest(".actions")) {
    hideMenu();
    hideSideMenu();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideMenu();
    hideSideMenu();
  }
});
msgsEl.addEventListener("scroll", () => {
  hideMenu();
  followScroll = nearBottom(); // 用户滚动即表态：在底部 → 跟随；翻走 → 暂停
});

// 已存消息（带 id）渲染操作按钮：删除单条 / 截断（删这条及之后）
function addMsg(role, text, id) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (id != null) div.dataset.id = id;
  if (role === "step") {
    div.append(stepBox(text));
  } else {
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    div.append(b);
  }
  if (id != null) {
    const actions = document.createElement("div");
    actions.className = "actions";
    const fork = document.createElement("button");
    fork.textContent = "分叉";
    fork.title = "从这条消息分叉出新会话（含此消息及之前，内容零复制）";
    fork.onclick = () => { hideMenu(); forkAt(id); };
    const ask = document.createElement("button");
    ask.textContent = "请求";
    ask.title = "以这条消息为最后一条重新请求回复，回复插入在其后（后续消息保留）";
    ask.onclick = () => { hideMenu(); askAt(id); };
    const edit = document.createElement("button");
    edit.textContent = "修改";
    edit.title = "修改这条消息的内容（只改本会话，共享此消息的其他会话不受影响）";
    edit.onclick = () => { hideMenu(); editAt(id); };
    const del = document.createElement("button");
    del.textContent = "删除";
    del.title = "删除这条消息";
    del.className = "danger";
    del.onclick = () => { hideMenu(); removeMsg(id, "delete"); };
    const trunc = document.createElement("button");
    trunc.textContent = "截断";
    trunc.title = "删除这条及之后的所有消息";
    trunc.className = "danger";
    trunc.onclick = () => { hideMenu(); removeMsg(id, "truncate"); };
    actions.append(fork, ask, edit, del, trunc);
    div.append(actions);
  }
  msgsEl.append(div);
  autoScroll();
  return div;
}

async function removeMsg(id, kind) {
  if (kind === "truncate" && !confirm("截断：删除这条消息及之后的所有消息？此操作不可撤销。")) return;
  try {
    const r = await api(`/api/messages/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, session: currentSession }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`操作失败: ${data.error ?? r.status}`);
      return;
    }
  } catch (e) {
    alert(`连接中断: ${e}`);
    return;
  }
  load();
}

async function load() {
  try {
    const r = await api(`/api/messages?session=${encodeURIComponent(currentSession)}`);
    const list = await r.json();
    msgsEl.textContent = "";
    for (const m of list) addMsg(m.role, m.text, m.id);
  } catch (e) {
    console.error("加载失败:", e);
  }
}

// SSE 流消费：把 response.body 逐块解码成 (event, data) 回调。
// POST 的流式不能用 EventSource（它只支持 GET），用 fetch 的 ReadableStream 手解 SSE 块。
async function readSSE(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) onEvent(event, JSON.parse(data.join("\n")));
    }
  }
}

// 发送按钮在流式进行中变"停止"（复用同一元素，不新增实体）：点停止 → POST /api/abort，
// core 中断 LLM 调用并保留已生成的部分作为回复；正在执行的工具也会被终止（run_cmd 杀子进程、
// daemon 调用中断），工具轮之间不再调度剩余工具，流照常以 done 收尾。
let aborting = false;
const SEND_LABEL = "发送";
function setSendUI(state) {
  if (state === "idle") {
    sending = false;
    aborting = false;
    sendBtn.textContent = SEND_LABEL;
    sendBtn.classList.remove("stop");
    sendBtn.disabled = false;
  } else if (state === "sending") {
    sendBtn.textContent = "■ 停止";
    sendBtn.classList.add("stop");
    sendBtn.disabled = false;
  } else {
    sendBtn.textContent = "停止中…";
    sendBtn.disabled = true;
  }
}

async function stopResponse() {
  if (!sending || aborting) return;
  aborting = true;
  setSendUI("aborting");
  try {
    await api("/api/abort", { method: "POST", body: JSON.stringify({ session: currentSession }) });
  } catch {} // 旧 core 没有该端点：忽略，等流自然结束
}

async function send(text, atId, opts) {
  const regen = opts?.regen === true;
  if ((!text && !regen) || sending) return;
  sending = true;
  setSendUI("sending");
  input.value = "";
  input.style.height = "auto"; // 多行输入发送后恢复单行
  // at 模式（消息右键"请求"）：用户消息不乐观渲染——它插入在 at 之后，done 后 load() 整表重绘位置才对
  if (atId == null) addMsg("user", text);
  followScroll = true; // 用户主动发送 = 意图看最新回复，恢复跟随
  // 实时区：一个可更新的回复气泡 + 实时步骤卡片容器（think/tool 上屏；done 后 load() 整表重绘替换掉它们）
  const live = addMsg("agent", "⏳ agent 思考中…");
  const bubble = live.querySelector(".bubble");
  const liveSteps = document.createElement("div");
  msgsEl.insertBefore(liveSteps, live);
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    if (bubble) bubble.textContent = "";
  };
  let thinkPre = null; // 当前思考卡片的 pre（每个工具轮开新卡）
  let toolSeq = 0;
  const toolPres = new Map(); // 工具卡片 key → pre（结果事件按执行顺序补回来）
  const showThink = (delta) => {
    start();
    if (!thinkPre) {
      const det = document.createElement("details");
      det.className = "stepbox";
      det.open = true;
      const sum = document.createElement("summary");
      sum.textContent = "思考";
      thinkPre = document.createElement("pre");
      det.append(sum, thinkPre);
      liveSteps.append(det);
    }
    thinkPre.textContent += delta;
    autoScroll();
  };
  const showTool = ({ name, args }) => {
    start();
    thinkPre = null; // 工具轮开始：下一条思考另起卡片
    const det = document.createElement("details");
    det.className = "stepbox";
    det.open = true;
    const sum = document.createElement("summary");
    sum.textContent = `工具 · ${name}`;
    const pre = document.createElement("pre");
    pre.textContent = `参数: ${args ?? ""}`;
    det.append(sum, pre);
    liveSteps.append(det);
    toolPres.set(`t${toolSeq++}`, pre);
    autoScroll();
  };
  const showToolResult = ({ result }) => {
    start();
    const pre = toolPres.get(`t${toolSeq - 1}`); // 结果按工具执行顺序到达，对应当前最后一张卡
    if (pre) pre.textContent += `\n结果: ${result ?? ""}`;
    autoScroll();
  };
  const cleanup = () => { live.remove(); liveSteps.remove(); };
  try {
    const r = await api("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        text,
        session: currentSession,
        ...(atId != null ? { at: atId } : {}),
        ...(regen ? { regen: true } : {}),
      }),
    });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.includes("text/event-stream")) {
      // 服务端走 JSON（busy/错误，或旧 core 不支持流式）：回退到原来的整体返回
      cleanup();
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) load(); // 整表重载：用户消息 + 思考/工具步骤 + 最终回复
      else addMsg("system", `出错了: ${data.error ?? r.status}`);
      return;
    }
    await readSSE(r.body, (event, data) => {
      if (event === "think") showThink(data.delta ?? "");
      else if (event === "tool") showTool(data);
      else if (event === "toolResult") showToolResult(data);
      else if (event === "delta") {
        start();
        if (bubble) bubble.textContent += data.text ?? "";
        autoScroll();
      } else if (event === "done") {
        load(); // 整表重绘（历史已入库，从 DB 真源重画：实时卡片随之替换）
      } else if (event === "error") {
        cleanup();
        addMsg("system", `出错了: ${data.message ?? "未知错误"}`);
      }
    });
  } catch (e) {
    cleanup();
    addMsg("system", `连接中断: ${e}`);
  } finally {
    setSendUI("idle");
    input.focus();
  }
}

// provider/模型选择器：/api/models 有则显示下拉，切换即 POST 生效。
// localStorage 按端口（每个 core 独立端口 = 独立 origin）记忆选择，换血重载后自动恢复。
const modRow = $("#modRow");
const providerSel = $("#providerSel");
const modelSel = $("#modelSel");
let catalog = [];

async function applyModel({ providerId, modelId }) {
  const p = catalog.find((x) => x.id === providerId);
  if (!p) return;
  const fill = modelId && p.models.includes(modelId) ? modelId : p.models[0];
  if (!fill) return;
  // 总是重建模型下拉：空 select 追加选项时浏览器会先自动选中第一个 option，
  // 此时 providerSel.value 已等于目标值，用 value 判断"是否变了"会误跳过重建
  providerSel.value = providerId;
  modelSel.textContent = "";
  for (const m of p.models) modelSel.append(new Option(m, m));
  modelSel.value = fill;
  const r = await api("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId, modelId: fill, session: currentSession }), // 模型选择记到当前会话
  });
  if (r.ok) return true;
  return false;
}

async function initModels() {
  // 会话感知：当前会话记过的模型优先（服务端存），无记录回落全局当前
  const r = await api(`/api/models?session=${encodeURIComponent(currentSession)}`);
  if (!r.ok) return; // 未配置公共资源库 → 隐藏选择行
  const data = await r.json();
  catalog = data.catalog || [];
  if (catalog.length === 0) return;
  modRow.hidden = false;
  for (const p of catalog) providerSel.append(new Option(p.id, p.id));
  await applyModel(data.current);
  providerSel.onchange = () => applyModel({ providerId: providerSel.value, modelId: null });
  modelSel.onchange = () => applyModel({ providerId: providerSel.value, modelId: modelSel.value });
}

sendBtn.onclick = () => { if (sending) stopResponse(); else send(input.value.trim()); };
input.addEventListener("keydown", (e) => {
  // Enter 发送（Shift+Enter 是原生换行，不拦截）
  if (e.key === "Enter" && !e.shiftKey && !sending) {
    e.preventDefault();
    send(input.value.trim());
  }
});
// 多行输入自适应高度（上限 160px，超出滚动）
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
// 会话侧栏初始化：旧 core 无会话 API → 保持隐藏，按单会话运行
(async () => {
  if (localStorage.getItem(SIDE_KEY) === "1") sessionSide.classList.add("collapsed");
  const list = await refreshSessions(localStorage.getItem(SESSION_KEY) || "default");
  if (list) sessionSide.hidden = false;
  load();
  await initModels(); // 会话确定后再加载模型（GET 带 session，恢复该会话的选择）
})();
