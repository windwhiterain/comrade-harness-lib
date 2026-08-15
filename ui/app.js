// 普通网页 —— 没有框架，没有构建。standard core 的对话界面。
"use strict";
const $ = (s) => document.querySelector(s);
const msgsEl = $("#msgs");
const input = $("#input");
const sendBtn = $("#send");
const pauseBtn = $("#pauseBtn");
const stopPauseBtn = $("#stopPause");
let sending = false;
const INPUT_PLACEHOLDER = "对 agent 说话…（Shift+Enter 换行；留空发送 = 空消息，模型接着继续）";
// 逐步暂停状态：pause 事件（流里每步收尾）进入暂停——按钮变"继续"，输入消息回车/点继续 = 唤醒暂停的流
// （文本非空插入为一条 user 消息，空 = 只继续不插入）；模式开关与"继续"合并成一个按钮：空闲 = 「暂停/暂停中」
// （切换模式），暂停挂起 = 「继续 ⏵」（唤醒，resume 请求带当前模式同步服务端——关掉后后续步骤不再停）
let paused = false;
let pausedSession = null; // 暂停时记下会话：暂停中切走会话，继续仍发回原会话
const PAUSE_KEY = "pauseMode"; // 模式状态按端口（core 独立 origin）记住
let pauseMode = localStorage.getItem(PAUSE_KEY) === "1";

// ---- 会话（多会话）：左侧栏列表（类似壳的 cores 列表），分叉做进消息右键菜单。 ----
// 旧 core 没有 /api/sessions → 侧栏隐藏，按单会话运行（所有请求不带 session，行为与原来一致）。
const sessionSide = $("#sessionSide");
const sessionList = $("#sessionList");
const newSessionBtn = $("#newSession");
const sidesTitle = document.querySelector(".sides-title"); // 点标题折叠/展开（与壳的 cores 侧栏一致）
let currentSession = "default";
const SESSION_KEY = "sessionSel"; // localStorage 按端口（每个 core 独立 origin）记住当前会话
const SIDE_KEY = "sessionSideCollapsed";

// 会话项右键菜单（复制会话 / 删除会话；default 也可删，删后作为锚点会在无 session 请求时自动重建）
// 复制 = 整个会话（全部引用）复制为新会话，内容零复制（共享消息池）——消息级"分叉"已废除，复制在会话层面做。
const sideMenu = document.createElement("div");
sideMenu.className = "actions side-menu";
const sideMenuCopy = document.createElement("button");
sideMenuCopy.textContent = "复制会话";
sideMenu.append(sideMenuCopy);
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

sideMenuCopy.onclick = async () => {
  hideSideMenu();
  const sid = sideMenu.dataset.id;
  const name = prompt("复制会话为新会话，名称:", `${sid}-copy`);
  if (!name) return;
  await createSession(name, sid, undefined, sid); // 复制全部引用（无 at）；模型设置继承被复制的会话
};

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
  followScroll = true; // 删会话 = 换会话，看剩余会话的最新内容
  load();
  applySessionModel(); // 删除可能换了当前会话（删光重建的锚点无记录）：下拉刷新成它实际将用的模型，不许残留旧值
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
    cnt.textContent = `${s.count}`;
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
  followScroll = true; // 换会话 = 看这个会话的最新内容（跨会话列表，位置锚定无意义，直接回底）
  load();
  applySessionModel(); // 恢复该会话记过的模型（无记录则保持当前选择）
}

// 切换会话后恢复该会话的 provider/model（服务端按会话存）
async function applySessionModel() {
  if (catalog.length === 0) return;
  const r = await api(`/api/models?session=${encodeURIComponent(currentSession)}`);
  if (!r.ok) return;
  const d = await r.json();
  if (d.current) renderModel(d.current);
}

async function createSession(name, fork, at, settingsFrom) {
  const r = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      ...(fork ? { fork, ...(at != null ? { at } : {}) } : {}),
      settingsFrom: settingsFrom ?? currentSession, // 新会话继承源会话的 provider/model 设置
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(`${fork ? "分叉" : "新建"}失败: ${d.error ?? r.status}`);
    return null;
  }
  await refreshSessions(d.id);
  followScroll = true; // 新建/分叉会话 = 从新会话底部开始看
  load();
  applySessionModel(); // 新会话已继承当前会话的设置（服务端复制），下拉与源会话一致
  return d.id;
}

newSessionBtn.onclick = () => {
  const name = prompt("新会话名称:");
  if (name) createSession(name);
};

// 消息右键菜单"继续"：以这条消息为最后一条重新请求回复，回复插入在其后（后续消息保留）。
// 重新生成模式：不新增用户消息、不依赖输入框，直接请求（LLM 输入的最后一条 = 这条消息）
async function askAt(messageId) {
  send("", messageId, { regen: true });
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

// stepbox 内 pre 的滚动跟随：与对话历史同一套语义——贴底时新内容（流式 think/toolResult 追加）
// 继续滚到底，翻到内容前部则暂停跟随，滚回底部恢复。每个卡片独立记录。
const preFollow = new WeakMap();
function preNearBottom(pre) {
  return pre.scrollHeight - pre.scrollTop - pre.clientHeight < SCROLL_NEAR_BOTTOM;
}
function trackPre(pre) {
  preFollow.set(pre, true); // 新卡片内容尚短，视为在底部
  pre.addEventListener("scroll", () => preFollow.set(pre, preNearBottom(pre)));
}
function preAppend(pre, text) {
  pre.textContent += text;
  if (preFollow.get(pre)) pre.scrollTop = pre.scrollHeight;
}

// ---- markdown 渲染（消息即时渲染成 HTML，库 = vendored markdown-it 15，html:false 默认净化输出，不用 DOMPurify） ----
const md = window.markdownit ? window.markdownit({ html: false, linkify: true, breaks: true }) : null;
function mdRender(text) {
  if (!md) return String(text ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return md.render(text ?? "");
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

// 步骤行（role="step"）：JSON → 可折叠卡片（思考/工具调用，含参数与结果）。
// LLM 统计例外：一行纯信息，不是消息——不可展开、无右键菜单。
function stepBox(raw) {
  let s = null;
  try { s = JSON.parse(raw); } catch {}
  if (s && s.type === "llm") {
    const u = s.usage || {};
    const info = document.createElement("div");
    info.className = "llmstat";
    info.textContent = `LLM 统计 · 输入 ${u.promptTokens ?? 0} · 缓存命中 ${u.cacheHitTokens ?? 0} · 输出 ${u.completionTokens ?? 0} · 合计 ${u.totalTokens ?? 0}`;
    return info;
  }
  if (s && s.type === "cut") {
    // 截断/空回复日志行：像 LLM 统计那样一行展示，不是对话消息（对话里不出现截断事件）
    const info = document.createElement("div");
    info.className = "llmstat";
    if (s.aborted) info.textContent = "已停止（用户终止，半截输出未保留）";
    else if (s.giveUp) info.textContent = `流持续被截断（finish=${s.finish ?? "-"}）· 已放弃续跑`;
    else if (s.stopped) info.textContent = "模型未生成回复（正常收尾）";
    else if (s.error && s.finish === undefined) info.textContent = s.error; // LLM/工具失败：直接显示错误（不是截断续跑）
    else info.textContent = `流被网关截断（finish=${s.finish ?? "-"}${s.error ? ` error=${s.error}` : ""}）· 已自动续跑`;
    return info;
  }
  const det = document.createElement("details");
  det.className = "stepbox";
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

// 右键菜单：消息大框上的 删除/截断/继续；小框（字段）上的 删除/修改。每条消息/字段的 .actions 就是它的菜单。
function hideMenu() {
  for (const a of document.querySelectorAll(".actions.show")) a.classList.remove("show");
}

function showMenu(el, x, y) {
  hideMenu();
  // 菜单挂在 el 自己身上（小框 .fld 的直接子元素 / 大框 .msg 的 .msgbox 里），不继承子孙的。
  // 占位小框（live，无自己的字段菜单）回落所属大框的菜单（停止生成）。
  let menu = el.querySelector(":scope > .actions, :scope > .msgbox > .actions");
  if (!menu) {
    const msg = el.closest(".msg");
    if (msg && msg !== el) menu = msg.querySelector(":scope > .actions, :scope > .msgbox > .actions");
    if (!menu) return;
  }
  menu.classList.add("show");
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}

// 右键任意带 id 的小框（.fld）→ 字段菜单（删除/修改）；否则带 id 的消息大框 → 大框菜单（继续/删除/截断）。
// 流式占位消息（dataset.live，未落库无 id）→ 大框菜单只剩"停止生成"；小框右键回落大框菜单。
// 系统提示/临时气泡没有 id 也没有 live，交回浏览器默认菜单。llmstat/cut 日志行没有 id，也没有菜单。
function openMenuFor(e) {
  const fld = e.target.closest(".fld");
  if (fld && (fld.dataset.id != null || fld.dataset.live != null)) {
    if (e.target.closest(".actions")) return; // 在菜单上右键不重开
    e.preventDefault();
    showMenu(fld, e.clientX, e.clientY);
    return;
  }
  const msg = e.target.closest(".msg");
  if (!msg || (msg.dataset.id == null && msg.dataset.live == null)) return;
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
// 用户滚动信号：区分"人真的在滚"与"内容增长/收缩触发的布局滚动事件"。浏览器在内容变高/变矮时
// 会自动触发 scroll 事件（不是用户动作）——naive 的 scrollTop 判定会把它们误判成"用户翻走了"，
// 跟随随之失效（Theia #15822 同款症状：工具调用一出现 auto-scroll 就停；本文档库实测同）。
// wheel/触摸/拖滚动条/翻页键才会点亮信号（300ms 窗口，拖动期间持续刷新）。
let userScrollSignal = false;
let userScrollTimer = null;
function markUserScroll() {
  userScrollSignal = true;
  clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(() => { userScrollSignal = false; }, 300);
}
msgsEl.addEventListener("wheel", markUserScroll, { passive: true });
msgsEl.addEventListener("touchmove", markUserScroll, { passive: true });
msgsEl.addEventListener("pointerdown", markUserScroll); // 鼠标点击/拖滚动条拇指/触摸起始
document.addEventListener("keydown", (e) => {
  if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return; // 输入框方向键/翻页不误报
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) markUserScroll();
});
msgsEl.addEventListener("scroll", () => {
  hideMenu();
  if (userScrollSignal) {
    followScroll = nearBottom(); // 用户滚动即表态：在底部 → 跟随；翻走 → 暂停
  } else if (followScroll && !nearBottom()) {
    msgsEl.scrollTop = msgsEl.scrollHeight; // 布局滚动事件（内容突然插入/增长把视口从底部推走）：跟随中重新钉底
  }
});

// 一条标准消息 → 新结构渲染。渲染状态 state 跨消息（load 逐条调）：
//   lastAssistant  = 最近一个 assistant 大框元素（step 日志行归位到它里面）
//   pendingGroup   = 当前 assistant 的 tool 结果组（{box, ids, ownerId}，tool 消息往里填）
//   pendingCallIds = 该组期望的 tool_call id 集合
// 结构：assistant = 一个 .msgbox 大框，内含若干 .fld 小框（reasoning / content / 每个 tool_call 一个），
// 大框右键 = 继续（有 tool_call 时不允许）/截断；小框右键 = 删除/修改。
// 响应同一 assistant 的 tool 消息们 = 一个独立的 .msgbox 组框（每个 tool 消息一个 .fld），
// 组框右键 = 继续（以最后一条工具结果为终点）/删除（连带删所有 tool_call）/截断；小框右键 = 删除（连带删对应 tool_call）/修改。
// user = 一个气泡框，右键 = 继续/删除/截断。role=step 日志行（llm/cut）挂进（它之后的）assistant 大框，无菜单。
// llm 统计行的归属：DB 顺序里 llm 日志在其所属 assistant **之前**一条（flow 先落 llm 日志再落 assistant）——
// 挂"最近 assistant"会挂错到上一轮（实测 zz-glob：74/78/81 全错位）。改为暂存 pendingLLM，等下一个
// assistant 渲染时挂进它的 msgbox；渲染完还剩下的才独立一行（孤儿 llm）。cut 日志（截断/失败/已停止）在
// assistant 之后或不配 assistant，仍挂最近。
function addMsg(m, state = {}) {
  const st = state;
  st.lastAssistant ??= null;
  st.pendingGroup ??= null;
  st.pendingCallIds ??= null;
  st.pendingLLM ??= null;
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  if (m.role === "step") {
    const box = stepBox(m.content);
    if (box.classList.contains("llmstat")) {
      if ((m.content || "").includes('"type":"llm"')) {
        (st.pendingLLM ??= []).push(box); // 属于"下一条 assistant"
        return null;
      }
      // cut 日志（截断/失败/已停止）：挂最近的 assistant
      if (st.lastAssistant) st.lastAssistant.querySelector(".msgbox").append(box);
      else msgsEl.append(box);
      return null;
    }
    div.append(box);
    msgsEl.append(div);
    return div;
  }
  if (m.role === "assistant") {
    if (m.id != null) div.dataset.id = m.id; // 流式占位消息（未落库，无 id）：标 live，右键弹"停止生成"
    else div.dataset.live = "1";
    const box = document.createElement("div");
    box.className = "msgbox";
    // 小框公共骨架：details（标题 = summary，点击折叠/展开，高度随内容）+ 字段菜单（删除/修改，在 details 外——
    // 折叠时右键仍可用）。无 id 的占位消息不建字段菜单（删除/修改需要真实消息 id）。
    const fld = (title, field, bodyEl, current, toolCallId, openDefault = true) => {
      const f = document.createElement("div");
      f.className = "fld";
      if (m.id != null) f.dataset.id = m.id;
      else f.dataset.live = "1"; // 占位小框也没有字段菜单，右键回落到所属大框的菜单
      f.dataset.field = field;
      if (toolCallId) f.dataset.toolId = toolCallId;
      const det = document.createElement("details");
      if (openDefault) det.open = true; // 默认展开；点击标题折叠（框的高度随内容而定，折叠后只剩标题一行）
      const sum = document.createElement("summary");
      sum.className = "fld-head";
      sum.textContent = title;
      det.append(sum, bodyEl);
      if (m.id == null) {
        f.append(det);
        return f;
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        btn("删除", "置为空（消息保留；删除由显式按钮完成）", () => clearMsg(m.id, field, toolCallId), true),
        btn("修改", "原地修改（Enter 提交，Shift+Enter 换行，Esc 取消）· 只改本会话", (b) => editField(m.id, field, current, toolCallId, b)),
      );
      f.append(det, actions);
      return f;
    };
    if (m.reasoning_content) {
      const pre = document.createElement("pre");
      pre.className = "fld-body";
      pre.textContent = m.reasoning_content;
      box.append(fld("思考", "reasoning", pre, m.reasoning_content));
    }
    if (m.content) {
      const b = document.createElement("div");
      b.className = "bubble";
      b.dataset.raw = m.content; // 原始 markdown 文本：修改的编辑框要用源文，不是渲染后的纯文本
      b.innerHTML = mdRender(m.content);
      box.append(fld("回复", "content", b, m.content));
    }
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const pre = document.createElement("pre");
        pre.className = "fld-body";
        pre.textContent = tc.function.arguments ?? "";
        // 工具调用默认折叠（参数可能很长，同工具结果——长内容不撑爆页面/视口）
        box.append(fld(`工具 · ${tc.function.name}`, "toolcall", pre, tc.function.arguments ?? "", tc.id, false));
      }
    }
    // 大框菜单：继续（有 tool_call 时不允许——重新生成的上下文终点不能是挂起工具调用的消息）/ 删除 / 截断。
    // 流式占位消息（无 id，未落库）只有"停止生成"可做——删除/截断/继续都需要真实 id，done 重绘后才有。
    if (m.id != null) {
      const actions = document.createElement("div");
      actions.className = "actions";
      if (!m.tool_calls?.length) actions.append(btn("继续", "以这条消息为最后一条重新生成回复（后续消息保留）", () => askAt(m.id)));
      actions.append(btn("删除", "删除这条消息（工具结果若还在会独立成组）", () => removeMsg(m.id, "delete"), true));
      actions.append(btn("截断", "删除这条及之后的所有消息", () => removeMsg(m.id, "truncate")));
      box.append(actions);
    } else {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(btn("停止生成", "终止当前生成（已生成的部分不保留为回复）", stopResponse));
      box.append(actions);
    }
    // 挂入这个 assistant 的 pendingLLM（它之前的 llm 统计行——DB 顺序 llm 在其 assistant 前一条）
    if (st.pendingLLM?.length) {
      for (const b of st.pendingLLM) box.append(b);
      st.pendingLLM = null;
    }
    div.append(box);
    msgsEl.append(div);
    st.lastAssistant = div;
    // 预建工具结果组框：该 assistant 的 tool 消息随后填进来（组菜单在最后，小框插到它前面）
    if (m.tool_calls?.length) {
      const g = document.createElement("div");
      g.className = "msg toolgroup";
      g.dataset.id = m.id; // 组框 id = owner assistant（截断定位用不到，菜单闭包直接用 ids）
      const gbox = document.createElement("div");
      gbox.className = "msgbox";
      const ids = [];
      const gactions = document.createElement("div");
      gactions.className = "actions";
      gactions.append(
        btn("继续", "以最后一条工具结果为最后一条重新生成回复", () => askAt(ids[ids.length - 1])),
        btn("删除", "删除整组工具调用与结果", () => clearMany(ids, "tool"), true),
        btn("截断", "删除这一组及之后的所有消息", () => removeMsg(ids[0], "truncate")),
      );
      gbox.append(gactions);
      g.append(gbox);
      msgsEl.append(g);
      st.pendingGroup = { box: gbox, ids, ownerId: m.id };
      st.pendingCallIds = new Set(m.tool_calls.map((t) => t.id));
    } else {
      st.pendingGroup = null;
      st.pendingCallIds = null;
    }
    return div;
  }
  if (m.role === "tool") {
    // 归属当前组：填进组框（插在组菜单前），小框菜单 = 删除（连带删对应 tool_call）/修改
    if (st.pendingCallIds?.has(m.tool_call_id)) {
      const f = document.createElement("div");
      f.className = "fld";
      f.dataset.id = m.id;
      f.dataset.field = "tool";
      const det = document.createElement("details");
      // 工具结果默认折叠（标题一行，点击展开）：长输出不撑爆页面/视口，贴底跟随不会被突然增长打断（用户拍板）
      const sum = document.createElement("summary");
      sum.className = "fld-head";
      sum.textContent = `工具结果 · ${m.tool_call_id}`;
      const pre = document.createElement("pre");
      pre.className = "fld-body";
      pre.textContent = m.content ?? "";
      det.append(sum, pre);
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        btn("删除", "删除这条工具结果（对应 tool_call 一并移除）", () => clearMsg(m.id, "tool"), true),
        btn("修改", "原地修改工具结果文本（Enter 提交，Shift+Enter 换行，Esc 取消）· 只改本会话", (b) => editField(m.id, "tool", m.content ?? "", null, b)),
      );
      f.append(det, actions);
      st.pendingGroup.box.insertBefore(f, st.pendingGroup.box.querySelector(".actions"));
      st.pendingGroup.ids.push(m.id);
      return null;
    }
    // 孤立的工具结果（assistant 卡已被删/旧数据）：独立成组
    div.dataset.id = m.id;
    const box = document.createElement("div");
    box.className = "msgbox";
    const f = document.createElement("div");
    f.className = "fld";
    f.dataset.id = m.id;
    f.dataset.field = "tool";
    const det = document.createElement("details");
    // 默认折叠（与组内工具结果一致）：长输出不撑爆页面
    const sum = document.createElement("summary");
    sum.className = "fld-head";
    sum.textContent = `工具结果 · ${m.tool_call_id}`;
    const pre = document.createElement("pre");
    pre.className = "fld-body";
    pre.textContent = m.content ?? "";
    det.append(sum, pre);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      btn("删除", "删除这条工具结果", () => clearMsg(m.id, "tool"), true),
      btn("修改", "原地修改工具结果文本（Enter 提交，Shift+Enter 换行，Esc 取消）· 只改本会话", (b) => editField(m.id, "tool", m.content ?? "", null, b)),
    );
    f.append(det, actions);
    box.append(f);
    div.append(box);
    msgsEl.append(div);
    return div;
  }
  // user / 系统提示等：单气泡框，右键 = 继续/删除/截断（user）；系统提示无 id 无菜单
  const b = document.createElement("div");
  b.className = "bubble";
  b.dataset.raw = m.content ?? "";
  b.innerHTML = mdRender(m.content || "（空消息）"); // 空消息可见：模型继续的轻推也是一条消息
  div.append(b);
  if (m.id != null) {
    div.dataset.id = m.id;
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      btn("继续", "以这条消息为最后一条重新生成回复（后续消息保留）", () => askAt(m.id)),
      btn("删除", "删除这条消息", () => removeMsg(m.id, "delete"), true),
      btn("截断", "删除这条及之后的所有消息", () => removeMsg(m.id, "truncate")),
    );
    div.append(actions);
  } else if (m.role === "user") {
    // 流式期间乐观渲染的 user 消息（未落库，无 id）：右键唯一可做 = 停止生成；系统提示（role=system）无菜单
    div.dataset.live = "1";
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(btn("停止生成", "终止当前生成（已生成的部分不保留为回复）", stopResponse));
    div.append(actions);
  }
  msgsEl.append(div);
  autoScroll();
  return div;
}

// 菜单按钮（文本/提示/动作/危险色；onClick 收按钮元素作末参，供"修改"原地编辑定位所属字段）
function btn(text, title, onClick, danger) {
  const b = document.createElement("button");
  b.textContent = text;
  b.title = title;
  if (danger) b.className = "danger";
  b.onclick = () => { hideMenu(); onClick(b); };
  return b;
}

// 字段级删除（删除 = 置为空）：reasoning/content/tool_calls（toolCallId = 单删一个 tool_call）/
// tool（删 tool 消息 + 连带对应 tool_call）。全空时服务端保留消息。
// field 来自小框的 dataset.field，toolcall 小框的标识是 "toolcall"，API 只认 "tool_calls"——这里映射。
async function clearMsg(id, field, toolCallId) {
  const apiField = field === "toolcall" ? "tool_calls" : field;
  try {
    const r = await api("/api/messages/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, field: apiField, ...(toolCallId ? { toolCallId } : {}), session: currentSession }),
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

// 批量字段删除（tool 组"删除"：逐条删 tool 消息，每条连带移除对应 tool_call；最后统一重绘）
async function clearMany(ids, field) {
  for (const id of ids) {
    try {
      const r = await api("/api/messages/clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, field, session: currentSession }),
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
  }
  load();
}

// 字段级修改（copy-on-edit：只改本会话；不校验改得合不合法——用户自己决定改什么）
// 原地编辑：字段主体替换成文本框（预填原文），Enter 提交、Shift+Enter 换行、Esc 或失焦取消（空文本 = 取消）。
// field 映射：小框标识 "toolcall"（改工具调用参数）→ API 的 "args"（需 toolCallId）。
function editField(id, field, current, toolCallId, btnEl) {
  const fld = btnEl.closest(".fld");
  const det = fld.querySelector("details");
  const body = det.children[1]; // details 子元素：summary（标题）后就是字段主体（pre.fld-body / div.bubble）
  const ta = document.createElement("textarea");
  ta.className = "fld-body edit";
  ta.value = current ?? "";
  ta.spellcheck = false;
  det.replaceChild(ta, body);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length); // 光标移到末尾，直接开改
  const restore = () => { if (det.contains(ta)) det.replaceChild(body, ta); };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitEdit(id, field, toolCallId, ta, restore); }
    else if (e.key === "Escape") { e.preventDefault(); restore(); }
  });
  ta.addEventListener("blur", restore); // 点击别处 = 放弃修改
}

async function submitEdit(id, field, toolCallId, ta, restore) {
  const text = ta.value;
  if (text.trim() === "") { restore(); return; } // 置空请用"删除"（与旧 prompt 行为一致）
  try {
    const r = await api("/api/messages/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, field: field === "toolcall" ? "args" : field, text, ...(toolCallId ? { toolCallId } : {}), session: currentSession }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`修改失败: ${data.error ?? r.status}`);
      return; // 保留文本框，改完可再 Enter 重试
    }
  } catch (e) {
    alert(`连接中断: ${e}`);
    return;
  }
  load();
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
  // 重绘前记住滚动位置：`textContent = ""` 会把 scrollTop 钳到 0，重绘后不恢复 = 视图跳回顶部
  // （done 整表重绘/删除/修改都走这里——贴底看输出的人每次都被拽走，真实踩过）。
  // 跟随中（贴底）→ 重绘后重新钉到底；翻到历史 → 按内容高度差值平移，锚定视口顶部，不把读者拽走。
  const prevScroll = msgsEl.scrollTop;
  const prevHeight = msgsEl.scrollHeight;
  try {
    const r = await api(`/api/messages?session=${encodeURIComponent(currentSession)}`);
    const list = await r.json();
    msgsEl.textContent = "";
    // 跨消息渲染状态：assistant 大框（step 日志归位）+ tool 结果组（tool 消息填充）
    const state = { lastAssistant: null, pendingGroup: null, pendingCallIds: null };
    for (const m of list) addMsg(m, state);
    // 残留的孤儿 llm 统计（没有后续 assistant 的）独立显示；空工具组框（如 done 工具无结果）不显示
    if (state.pendingLLM?.length) for (const b of state.pendingLLM) msgsEl.append(b);
    for (const g of [...msgsEl.children].filter((c) => c.classList.contains("toolgroup"))) {
      if (!g.querySelector(".fld")) g.remove();
    }
  } catch (e) {
    console.error("加载失败:", e);
  }
  if (followScroll) autoScroll(); // 贴底 → 重新钉到底（钳位滚动事件随后按最终位置判定，跟随不丢）
  else msgsEl.scrollTop = Math.max(0, prevScroll + (msgsEl.scrollHeight - prevHeight));
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

// 底部一排按钮：步进 / 发送 / 停止-继续。状态机控制可用性：
// idle：发送可用（留空 = 空消息），步进按钮可用（模式开关：步进/步进中），停止按钮 = 「继续」（对最后一条重新生成）；
// sending：停止-继续按钮 = 「停止」（终止），发送置灰，步进按钮可用（步骤间可改：关了后面的步骤不再停——当前流不感知，
// 下次继续/发送请求才同步服务端）；paused：步进按钮变「继续 ⏵」（唤醒）/发送（插入消息继续）/「停止」（终止）都可用。
let aborting = false;
// 按钮显示：暂停挂起 = 「继续 ⏵」（唤醒动作）；否则 = 「步进」/「步进中」（模式开关，.on 高亮表示开启）
function renderPauseBtn() {
  if (paused) {
    pauseBtn.textContent = "继续 ⏵";
    pauseBtn.classList.remove("on");
    return;
  }
  pauseBtn.textContent = pauseMode ? "步进中" : "步进";
  pauseBtn.classList.toggle("on", pauseMode);
}
function setSendUI(state) {
  if (state === "idle") {
    sending = false;
    aborting = false;
    paused = false;
    pausedSession = null;
    sendBtn.disabled = false;
    stopPauseBtn.disabled = false;
    stopPauseBtn.classList.remove("stop"); // 空闲 = 「继续」（对最后一条消息重新生成），中性样式
    stopPauseBtn.textContent = "继续";
    stopPauseBtn.title = "对最后一条消息重新生成回复（与右键菜单「继续」一致）";
    pauseBtn.disabled = false;
    input.placeholder = INPUT_PLACEHOLDER;
  } else if (state === "sending") {
    sendBtn.disabled = true;
    stopPauseBtn.disabled = false;
    stopPauseBtn.classList.add("stop"); // busy = 「停止」（终止），红色
    stopPauseBtn.textContent = "停止";
    stopPauseBtn.title = "终止当前任务";
    pauseBtn.disabled = false; // 步骤间可改模式（下条请求生效）
    input.placeholder = INPUT_PLACEHOLDER;
  } else if (state === "paused") {
    // 逐步暂停：任务挂在"等继续"上——继续（按钮）= 空继续（不插入），发送 = 插入输入的消息继续，停止 = 终止
    sendBtn.disabled = false;
    stopPauseBtn.disabled = false;
    stopPauseBtn.classList.add("stop");
    stopPauseBtn.textContent = "停止";
    stopPauseBtn.title = "终止当前任务";
    pauseBtn.disabled = false;
    input.placeholder = "输入消息插入步骤中…（留空点继续 = 直接继续）";
  } else {
    sendBtn.disabled = true;
    stopPauseBtn.disabled = true;
    stopPauseBtn.classList.add("stop");
    stopPauseBtn.textContent = "停止";
    stopPauseBtn.title = "终止当前任务";
    pauseBtn.disabled = true;
  }
  renderPauseBtn();
}

async function stopResponse() {
  if (!sending || aborting) return;
  aborting = true;
  setSendUI("aborting");
  try {
    await api("/api/abort", { method: "POST", body: JSON.stringify({ session: pausedSession ?? currentSession }) });
  } catch {} // 旧 core 没有该端点：忽略，等流自然结束
}

// 暂停中"继续"：POST 同一条 /api/messages 唤醒暂停的流（服务端 busy 但暂停中 = 继续，不新建回合）。
// 文本非空 → 插入为一条 user 消息（乐观渲染，done 后 load() 整表重绘到正确位置）；空 → 只继续不插入。
async function resume() {
  const text = input.value.trim();
  input.value = "";
  input.style.height = "auto";
  if (text !== "") addMsg({ role: "user", content: text });
  try {
    const r = await api("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, session: pausedSession ?? currentSession, pause: pauseMode }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      addMsg({ role: "system", content: `继续失败: ${d.error ?? r.status}` });
      setSendUI("paused"); // 还停在暂停上
      return;
    }
    setSendUI("sending"); // 流已唤醒：接下来的 think/tool/delta 事件会继续上屏；下一次 pause 事件再回到暂停态
  } catch (e) {
    addMsg({ role: "system", content: `连接中断: ${e}` });
  }
}

async function send(text, atId, opts) {
  const regen = opts?.regen === true;
  if (sending) return; // 空消息合法：text "" = 一条空 user 消息（模型接着继续）；暂停中走 resume()
  sending = true;
  setSendUI("sending");
  input.value = "";
  input.style.height = "auto"; // 多行输入发送后恢复单行
  // at 模式（消息右键"继续"）：用户消息不乐观渲染——它插入在 at 之后，done 后 load() 整表重绘位置才对
  // 空消息也渲染（"（空消息）"占位）——允许空消息：进历史、进上下文，模型可见
  if (atId == null) addMsg({ role: "user", content: text });
  followScroll = true; // 用户主动发送 = 意图看最新回复，恢复跟随
  // 实时区：镜像静态渲染的消息结构——每次 LLM 补全 = 一条 assistant 消息 = 一个独立大框
  // （思考/回复/工具调用都是可折叠的小框，LLM 统计挂进大框；工具结果们 = 独立组框紧跟这条消息）。
  // 流式事件按消息归属：think/delta 累积进当前消息；工具轮（tool 事件）后当前消息封存，下一个
  // 补全的 think/delta 开新消息；截断同理（自动续跑 = 新补全 = 新消息）。done 后 load() 从 DB
  // 整表重绘替换掉流式卡——DB 是实时落盘的（agentLoop live），流式上屏与落库同源同构，重绘不丢。
  const streamEls = []; // 流式期间创建的所有元素（cleanup 时移除）
  let cur = null; // 当前 assistant 消息 { live, box, bubble, raw, timer, thinkPre, toolGroup, sealed }
  const newMsg = () => {
    const live = addMsg({ role: "assistant", content: "⏳ agent 思考中…" });
    const bubble = live.querySelector(".bubble");
    if (bubble) bubble.textContent = ""; // 事件已到达，占位清空
    cur = {
      live,
      box: live.querySelector(".msgbox"),
      bubble,
      raw: "",
      timer: null,
      thinkPre: null,
      toolGroup: null, // { el, box, cur }：这条消息的工具结果组框（紧跟 live 卡）
      sealed: false, // 工具轮/截断后封存：下一个补全开新消息
    };
    streamEls.push(live);
    return cur;
  };
  // 可折叠小框（details）：标题 = summary（点击折叠/展开），正文 = pre（流式累积）。field 标识与静态渲染一致。
  // openDefault=false：工具结果默认折叠（长输出不撑爆页面/视口，贴底跟随不会被突然增长打断——用户拍板）。
  const liveFld = (title, field, bodyText, openDefault = true) => {
    const f = document.createElement("div");
    f.className = "fld";
    f.dataset.field = field;
    const det = document.createElement("details");
    if (openDefault) det.open = true;
    const sum = document.createElement("summary");
    sum.className = "fld-head";
    sum.textContent = title;
    const pre = document.createElement("pre");
    pre.className = "fld-body";
    pre.textContent = bodyText;
    det.append(sum, pre);
    f.append(det);
    return { f, pre };
  };
  const showThink = (delta) => {
    if (!cur || cur.sealed) newMsg(); // 上一条消息已收尾，这段思考属于新消息
    if (!cur.thinkPre) {
      const { f, pre } = liveFld("思考", "reasoning", "");
      cur.thinkPre = pre;
      // 思考在回复（content 小框）之上——addMsg 建卡时 content 占位先建了回复小框，思考插到它前面
      // （静态渲染是 reasoning → content → toolcall，流式顺序必须同构，不然完成重绘会跳位）
      cur.box.insertBefore(f, cur.box.querySelector(".fld") ?? cur.box.querySelector(":scope > .actions"));
      trackPre(pre);
    }
    preAppend(cur.thinkPre, delta);
    autoScroll();
  };
  const showDelta = (text) => {
    if (!cur || cur.sealed) newMsg();
    cur.raw += text;
    if (!cur.timer) {
      cur.timer = setTimeout(() => {
        // 流式 markdown 即时渲染：delta 累积进原始文本，60ms 节流整段重渲（每次 delta 都渲会闪烁/抖动）
        cur.timer = null;
        if (cur.bubble) {
          cur.bubble.innerHTML = mdRender(cur.raw);
          autoScroll();
        }
      }, 60);
    }
  };
  const showTool = ({ name, args }) => {
    if (!cur) newMsg(); // 无思考的工具轮（第一事件就是工具）：开一条消息
    const tc = liveFld(`工具 · ${name}`, "toolcall", args ?? "", false); // 工具调用默认折叠（参数可能很长）
    cur.box.insertBefore(tc.f, cur.box.querySelector(":scope > .actions"));
    // 工具结果组框（紧跟这条消息；每个工具一个结果小框，结果按执行顺序回填当前）
    if (!cur.toolGroup) {
      const g = document.createElement("div");
      g.className = "msg toolgroup";
      const gbox = document.createElement("div");
      gbox.className = "msgbox";
      g.append(gbox);
      msgsEl.insertBefore(g, cur.live.nextSibling);
      cur.toolGroup = { el: g, box: gbox, cur: null };
      streamEls.push(g);
    }
    const res = liveFld(`工具结果 · ${name}`, "tool", "", false);
    cur.toolGroup.box.append(res.f);
    cur.toolGroup.cur = res.pre;
    cur.sealed = true; // 工具轮 = 这条消息的收尾：下一个补全开新消息
  };
  const showToolResult = ({ result }) => {
    if (cur?.toolGroup?.cur) preAppend(cur.toolGroup.cur, result ?? "");
    autoScroll();
  };
  const showLLM = (usage) => {
    if (!cur) newMsg();
    const u = usage || {};
    const info = document.createElement("div");
    info.className = "llmstat";
    info.textContent = `LLM 统计 · 输入 ${u.promptTokens ?? 0} · 缓存命中 ${u.cacheHitTokens ?? 0} · 输出 ${u.completionTokens ?? 0} · 合计 ${u.totalTokens ?? 0}`;
    cur.box.append(info); // 挂进这条消息的大框（与静态渲染一致）
    autoScroll();
  };
  const showCut = (d) => {
    if (!cur) newMsg();
    const info = document.createElement("div");
    info.className = "llmstat";
    if (d.aborted) info.textContent = "已停止（用户终止，半截输出未保留）";
    else if (d.giveUp) info.textContent = `流持续被截断（finish=${d.finish ?? "-"}）· 已放弃续跑`;
    else if (d.stopped) info.textContent = "模型未生成回复（正常收尾）";
    else if (d.error && d.finish === undefined) info.textContent = d.error; // LLM/工具失败：直接显示错误（不是截断续跑）
    else info.textContent = `流被网关截断（finish=${d.finish ?? "-"}${d.error ? ` error=${d.error}` : ""}）· 已自动续跑`;
    cur.box.append(info);
    cur.sealed = true; // 截断/失败日志挂这条消息；自动续跑 = 新补全 = 新消息
    autoScroll();
  };
  const cleanup = () => {
    for (const el of streamEls) el.remove();
    streamEls.length = 0;
    cur = null;
  };
  try {
    const r = await api("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        text,
        session: currentSession,
        pause: pauseMode, // 逐步暂停模式随每条消息同步（关闭后后续步骤不再停）
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
      else addMsg({ role: "system", content: `出错了: ${data.error ?? r.status}` });
      return;
    }
    await readSSE(r.body, (event, data) => {
      if (event === "pause") {
        // 逐步暂停：该步已完成，任务挂在"等继续"上——按钮变"继续"，输入消息后回车/点继续唤醒
        paused = true;
        pausedSession = currentSession;
        setSendUI("paused");
      } else if (event === "think") {
        if (paused) setSendUI("sending"); // 有事件到达 = 流已唤醒（如另一标签页继续了），回运行态
        showThink(data.delta ?? "");
      } else if (event === "tool") {
        if (paused) setSendUI("sending");
        showTool(data);
      } else if (event === "toolResult") {
        showToolResult(data);
      } else if (event === "llm") {
        if (paused) setSendUI("sending");
        showLLM(data.usage);
      } else if (event === "cut") {
        if (paused) setSendUI("sending");
        showCut(data);
      } else if (event === "delta") {
        if (paused) setSendUI("sending");
        showDelta(data.text ?? "");
      } else if (event === "done") {
        load(); // 整表重绘（历史已入库，从 DB 真源重画：实时卡片随之替换）
      } else if (event === "error") {
        cleanup();
        // 已实时落盘的内容重绘保留——不然错误后界面只剩错误提示，用户看到"回复凭空消失"（实时落盘的意义所在）
        load().then(() => addMsg({ role: "system", content: `出错了: ${data.message ?? "未知错误"}` }));
      }
    });
  } catch (e) {
    cleanup();
    addMsg({ role: "system", content: `连接中断: ${e}` });
  } finally {
    setSendUI("idle");
    input.focus();
  }
}

// provider/模型选择器：/api/models 有则显示下拉，用户切换才 POST 生效。
// 下拉永远显示"服务端实际将用于该会话的模型"：加载/切会话只渲染（GET 已给出真值），
// 切换失败立即回滚到服务端真值并提示——下拉不许说谎（曾出现显示 deepseek 实际跑 minimax）。
const modRow = $("#modRow");
const providerSel = $("#providerSel");
const modelSel = $("#modelSel");
let catalog = [];

/** 纯显示：把两个下拉渲染成服务端给出的 (provider, model)，不发任何请求。 */
function renderModel({ providerId, modelId }) {
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
}

/** 用户切换：POST 落库（记到当前会话）。失败 → 提示 + 从服务端重新取真值渲染。 */
async function switchModel({ providerId, modelId }) {
  const p = catalog.find((x) => x.id === providerId);
  if (!p) return;
  const fill = modelId && p.models.includes(modelId) ? modelId : p.models[0];
  if (!fill) return;
  const r = await api("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId, modelId: fill, session: currentSession }), // 模型选择记到当前会话
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    addMsg({ role: "system", content: `切换模型失败: ${d.error ?? r.status}` });
    await applySessionModel(); // 回滚：重新取服务端真值渲染
    return;
  }
  renderModel({ providerId, modelId: fill });
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
  renderModel(data.current);
  providerSel.onchange = () => switchModel({ providerId: providerSel.value, modelId: null });
  modelSel.onchange = () => switchModel({ providerId: providerSel.value, modelId: modelSel.value });
}

sendBtn.onclick = () => {
  if (paused) { resume(input.value.trim()); return; } // 暂停中发送 = 插入消息继续
  if (sending) stopResponse(); else send(input.value.trim()); // 留空 = 空消息（允许）
};
pauseBtn.onclick = () => {
  if (paused) { resume(""); return; } // 暂停挂起：按钮是「继续 ⏵」——空继续（不插入消息，只唤醒暂停的流）
  if (aborting) return;
  // 空闲/步骤间：切换逐步暂停模式（本地 + 记忆；服务端随下次继续/发送请求同步）
  pauseMode = !pauseMode;
  localStorage.setItem(PAUSE_KEY, pauseMode ? "1" : "0");
  renderPauseBtn();
};
// 空闲"继续"的目标消息：从渲染 DOM 倒序找最后一个可重新生成的消息。
// 规则与右键菜单一致：assistant 带挂起工具调用不可为终点；toolgroup 以最后一条工具结果为终点；
// 流式占位/系统提示/日志行无 id，跳过。找不到（空对话）返回 null。
function lastMessageId() {
  const kids = msgsEl.children;
  for (let i = kids.length - 1; i >= 0; i--) {
    const el = kids[i];
    if (el.dataset.id == null) continue;
    if (el.classList.contains("toolgroup")) {
      const tools = el.querySelectorAll(".fld[data-field='tool']");
      if (tools.length) return Number(tools[tools.length - 1].dataset.id); // 组框 id 是 owner assistant，用最后工具结果
      continue; // 空组框（done 类工具）：跳过
    }
    if (el.classList.contains("assistant") && el.querySelector(".fld[data-field='toolcall']")) continue; // 挂起工具调用
    return Number(el.dataset.id);
  }
  return null;
}
// 底部"停止/继续"按钮：busy（发送中/暂停挂起）= 停止（终止）；空闲 = 继续（对最后一条消息重新生成）
stopPauseBtn.onclick = () => {
  if (sending) { stopResponse(); return; }
  const id = lastMessageId();
  if (id != null) askAt(id);
};
input.addEventListener("keydown", (e) => {
  // Enter 发送（Shift+Enter 是原生换行，不拦截）；暂停中 Enter = 继续（空 = 只继续不插入）
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (paused) { resume(input.value.trim()); return; }
    if (!sending) send(input.value.trim());
  }
});
// 多行输入自适应高度（上限 160px，超出滚动）
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
// 会话侧栏初始化：旧 core 无会话 API → 保持隐藏，按单会话运行
(async () => {
  setSendUI("idle"); // 底部按钮初始态：发送可用、步进可用、停止按钮 = 「继续」（对最后一条重新生成）
  if (localStorage.getItem(SIDE_KEY) === "1") sessionSide.classList.add("collapsed");
  const list = await refreshSessions(localStorage.getItem(SESSION_KEY) || "default");
  if (list) sessionSide.hidden = false;
  load();
  await initModels(); // 会话确定后再加载模型（GET 带 session，恢复该会话的选择）
})();
