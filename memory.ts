import { Database } from "bun:sqlite";
import { appendKey, midKey, rebalanceKeys } from "./order";
import type { ChatMessage, MemoryStore, MessageRecord, MsgOp, SessionInfo, SessionStore, StoredMessage } from "./types";

// 默认记忆组件：SQLite 消息历史（DB_PATH 由 daemon 注入）—— 进程可被随便换血，历史一条不丢。
// 消息 = OpenAI 标准形状（content / reasoning_content / tool_calls 三字段一体），text 列存 JSON，严格存储严格重建。

export function sqliteMemory(dbPath: string | undefined): MemoryStore {
  const db = new Database(dbPath ?? ":memory:", { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts TEXT NOT NULL
  )`);
  const parse = (r: { id: number; text: string; ts: string }): MessageRecord | null => {
    try {
      return { id: r.id, ts: r.ts, ...(JSON.parse(r.text) as object) } as MessageRecord;
    } catch {
      return null; // 旧数据（纯文本行）：跳过（不迁移）
    }
  };
  return {
    list: () =>
      db.query("SELECT id, text, ts FROM messages ORDER BY id").all()
        .map((r) => parse(r as { id: number; text: string; ts: string }))
        .filter((m): m is MessageRecord => m !== null),
    insert: (msg: StoredMessage) => {
      db.run("INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)", [msg.role, JSON.stringify(msg), new Date().toISOString()]);
    },
    delete: (id: number) => {
      db.run("DELETE FROM messages WHERE id = ?", [id]);
    },
    truncate: (fromId: number) => {
      db.run("DELETE FROM messages WHERE id >= ?", [fromId]);
    },
  };
}

// 会话化消息历史：消息池（messages，只追加，内容唯一储存）+ 会话（sessions）+ 有序引用列表（session_messages）。
// 多会话共享零复制——共享靠引用而非结构，前缀/中间/后缀消息都能被任意会话引用；
// 删除/截断/删会话/字段置空都是"删引用/换引用"，消息行留在池里（孤儿，可恢复），彻底清除留给将来的 purge。
// 流代码不用改：session(id) 返回 MemoryStore 视图，loadHistory/saveHistory 照常。
// 旧数据兼容：messages 表形状不变，首次启动自动迁移为 default 会话（无 session 的请求都落在它上面）；
// 旧格式行（纯文本 / 拆行 step）解析失败一律跳过，不迁移。

export function sqliteSessionStore(dbPath: string | undefined): SessionStore {
  const db = new Database(dbPath ?? ":memory:", { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    provider_id TEXT,
    model_id TEXT
  )`);
  // 迁移：旧库的 sessions 表没有模型列（ALTER 补上）；cost 列是已废除的费用累计残留，顺带删掉
  const sessionCols = db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "provider_id")) {
    db.run(`ALTER TABLE sessions ADD COLUMN provider_id TEXT`);
    db.run(`ALTER TABLE sessions ADD COLUMN model_id TEXT`);
  }
  if (sessionCols.some((c) => c.name === "cost")) {
    db.run(`ALTER TABLE sessions DROP COLUMN cost`);
  }
  db.run(`CREATE TABLE IF NOT EXISTS session_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    pos INTEGER NOT NULL,
    ord TEXT,
    PRIMARY KEY (session_id, message_id),
    UNIQUE (session_id, pos)
  )`);
  // 迁移（2026-08-16 顺序键）：加 ord 列（字典序字符串键，见 order.ts），旧库从 pos 灌入（零填充对齐，
  // 保持原顺序）；pos 降级为唯一占位（新行继续写 MAX+1，永不移位、不参与排序）。
  const smCols = db.query(`PRAGMA table_info(session_messages)`).all() as { name: string }[];
  if (!smCols.some((c) => c.name === "ord")) {
    db.run(`ALTER TABLE session_messages ADD COLUMN ord TEXT`);
    db.run(`UPDATE session_messages SET ord = printf('%09d', pos)`);
  }
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sm_ord ON session_messages(session_id, ord)`);
  // 全局模型选择的持久化（settings 键值表）：reload/重启后回落"上次切换的模型"而非启动默认
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  // 迁移/锚点：default 会话必然存在（旧单线性数据按 id 顺序链化；空库也建 default）
  const hasDefault = db.query(`SELECT id FROM sessions WHERE id = 'default'`).get();
  if (!hasDefault) {
    const now = new Date().toISOString();
    db.run(`INSERT INTO sessions (id, name, created, updated) VALUES ('default', '默认会话', ?, ?)`, [now, now]);
    db.run(`INSERT INTO session_messages (session_id, message_id, pos, ord) SELECT 'default', id, id, printf('%09d', id) FROM messages`);
  }

  const now = () => new Date().toISOString();

  const ensureSession = (id: string): void => {
    const exists = db.query(`SELECT id FROM sessions WHERE id = ?`).get(id);
    if (!exists) db.run(`INSERT INTO sessions (id, name, created, updated) VALUES (?, ?, ?, ?)`, [id, id, now(), now()]);
  };

  const readGlobalModel = (): { providerId: string; modelId: string } | null => {
    const row = db.query(`SELECT value FROM settings WHERE key = 'global_model'`).get() as { value?: string } | null;
    if (!row?.value) return null;
    try {
      const j = JSON.parse(row.value) as { providerId?: unknown; modelId?: unknown };
      if (typeof j.providerId === "string" && typeof j.modelId === "string") return { providerId: j.providerId, modelId: j.modelId };
    } catch {
      /* 坏值当无记录 */
    }
    return null;
  };
  const writeGlobalModel = (providerId: string, modelId: string): void => {
    db.run(
      `INSERT INTO settings (key, value) VALUES ('global_model', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ providerId, modelId })],
    );
  };

  /** 引用在会话内的顺序键（ord，字典序即会话内顺序）。 */
  const ordOf = (sessionId: string, messageId: number): string | null => {
    const row = db.query(`SELECT ord FROM session_messages WHERE session_id = ? AND message_id = ?`).get(sessionId, messageId) as { ord: string | null } | null;
    return row?.ord ?? null;
  };

  const nextPos = (sessionId: string): number => {
    const row = db.query(`SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM session_messages WHERE session_id = ?`).get(sessionId) as { p: number };
    return row.p;
  };

  /** 追加键：当前最大 ord（字典序最大 = 顺序最后）的后继。 */
  const nextOrd = (sessionId: string): string => {
    const row = db.query(`SELECT COALESCE(MAX(ord), '') AS o FROM session_messages WHERE session_id = ?`).get(sessionId) as { o: string };
    return appendKey(row.o);
  };

  /** 整表重排（键空间耗尽的兜底，O(n)，罕见）：先全部置 NULL（UNIQUE 索引不约束 NULL），再按序赋等间隔键。 */
  const rebalance = (sessionId: string): void => {
    const rows = db.query(`SELECT message_id FROM session_messages WHERE session_id = ? ORDER BY ord`).all(sessionId) as { message_id: number }[];
    db.transaction(() => {
      db.run(`UPDATE session_messages SET ord = NULL WHERE session_id = ?`, [sessionId]);
      const keys = rebalanceKeys(rows.map(() => ""));
      rows.forEach((r, i) => {
        db.run(`UPDATE session_messages SET ord = ? WHERE session_id = ? AND message_id = ?`, [keys[i], sessionId, r.message_id]);
      });
    })();
  };

  /** 池行 → 标准消息（解析失败 = 旧数据，跳过不迁移）。 */
  const parseRow = (r: { id: number; text: string; ts: string }): MessageRecord | null => {
    try {
      return { id: r.id, ts: r.ts, ...(JSON.parse(r.text) as object) } as MessageRecord;
    } catch {
      return null;
    }
  };

  /** 读池行（含 role）。 */
  const getRow = (id: number): { role: string; text: string; ts: string } | null =>
    (db.query(`SELECT role, text, ts FROM messages WHERE id = ?`).get(id) as { role: string; text: string; ts: string } | null);

  /** copy-on-edit：新池行 + 本会话引用改指新行。返回新 id。 */
  const replaceWith = (sessionId: string, id: number, msg: StoredMessage): number => {
    const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [msg.role, JSON.stringify(msg), now()]);
    db.run(`UPDATE session_messages SET message_id = ? WHERE session_id = ? AND message_id = ?`, [
      Number(info.lastInsertRowid), sessionId, id,
    ]);
    return Number(info.lastInsertRowid);
  };

  /** 删会话里 tool_call_id 匹配的 tool 消息引用（tool 消息失去挂载点，连带删除）。 */
  const dropToolRef = (sessionId: string, toolCallId: string) => {
    const rows = db.query(
      `SELECT sm.message_id, m.text FROM session_messages sm
       JOIN messages m ON m.id = sm.message_id
       WHERE sm.session_id = ? AND m.role = 'tool'`,
    ).all(sessionId) as { message_id: number; text: string }[];
    for (const tr of rows) {
      try {
        const tm = JSON.parse(tr.text) as { tool_call_id?: string };
        if (tm.tool_call_id === toolCallId) {
          db.run(`DELETE FROM session_messages WHERE session_id = ? AND message_id = ?`, [sessionId, tr.message_id]);
        }
      } catch { /* 旧数据行：跳过 */ }
    }
  };

  /** 找会话里 tool_calls 含该 id 的 assistant 消息（tool 侧删除时反向联动用）。 */
  const findToolOwner = (sessionId: string, toolCallId: string): { id: number; msg: ChatMessage } | null => {
    const rows = db.query(
      `SELECT m.id, m.text FROM session_messages sm
       JOIN messages m ON m.id = sm.message_id
       WHERE sm.session_id = ? AND m.role = 'assistant' ORDER BY sm.ord`,
    ).all(sessionId) as { id: number; text: string }[];
    for (const r of rows) {
      try {
        const m = JSON.parse(r.text) as ChatMessage;
        if (m.tool_calls?.some((c) => c.id === toolCallId)) return { id: r.id, msg: m };
      } catch { /* 旧数据行：跳过 */ }
    }
    return null;
  };

  /** 消息 JSON 的路径寻址（段以 "/" 分隔；数组段——tool_calls——按元素 id 匹配，不按下标）。
   *  就地读写；del 时数组段删除元素、对象段删除键。路径不存在抛错（调用方转成 op 失败）。 */
  const pathSegs = (path: string): string[] => path.split("/").filter(Boolean);
  function pathSet(obj: any, path: string, value: unknown): void {
    const segs = pathSegs(path);
    let cur: any = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      cur = Array.isArray(cur) ? cur.find((x: any) => x?.id === s) : cur?.[s];
      if (cur == null) throw new Error(`路径不存在: ${path}`);
    }
    const last = segs[segs.length - 1];
    if (Array.isArray(cur)) {
      const idx = cur.findIndex((x: any) => x?.id === last);
      if (idx < 0) throw new Error(`路径不存在: ${path}`);
      cur[idx] = value;
    } else {
      cur[last] = value;
    }
  }
  function pathDel(obj: any, path: string): void {
    const segs = pathSegs(path);
    let cur: any = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      cur = Array.isArray(cur) ? cur.find((x: any) => x?.id === s) : cur?.[s];
      if (cur == null) throw new Error(`路径不存在: ${path}`);
    }
    const last = segs[segs.length - 1];
    if (Array.isArray(cur)) {
      const idx = cur.findIndex((x: any) => x?.id === last);
      if (idx < 0) throw new Error(`路径不存在: ${path}`);
      cur.splice(idx, 1);
    } else {
      delete cur[last];
    }
  }

  const sessionView = (sessionId: string): MemoryStore => {
    // 引用写入助手（视图方法与 applyOps 共用；sessions.updated 由它们统一维护）
    const appendRef = (msg: StoredMessage): number => {
      const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [msg.role, JSON.stringify(msg), now()]);
      const id = Number(info.lastInsertRowid);
      db.run(`INSERT INTO session_messages (session_id, message_id, pos, ord) VALUES (?, ?, ?, ?)`, [sessionId, id, nextPos(sessionId), nextOrd(sessionId)]);
      db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
      return id;
    };
    const insertAfterRef = (id: number, msg: StoredMessage): number | null => {
      let o = ordOf(sessionId, id);
      if (o == null) return null;
      // 顺序键中间插入：取 id 与下一邻居之间的键（O(键长)）；键空间不足（罕见）→ 整表重排后重试。
      // 不再有 pos 重编号——中间插入从 O(n) 变 O(1) 摊还。
      let ord: string | null = null;
      for (let attempt = 0; attempt < 2 && ord == null; attempt++) {
        const next = db.query(
          `SELECT ord FROM session_messages WHERE session_id = ? AND ord > ? ORDER BY ord LIMIT 1`,
        ).all(sessionId, o) as { ord: string }[];
        const k = midKey(o, next[0]?.ord ?? "");
        if (k != null && k > o && (next.length === 0 || k < next[0].ord)) {
          ord = k;
          break;
        }
        rebalance(sessionId); // 重排会改变已有键：重新取 o 再试
        const o2 = ordOf(sessionId, id);
        if (o2 == null) return null;
        o = o2;
      }
      if (ord == null) return null; // 重排后仍失败：理论不可达
      const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [msg.role, JSON.stringify(msg), now()]);
      db.run(`INSERT INTO session_messages (session_id, message_id, pos, ord) VALUES (?, ?, ?, ?)`, [
        sessionId, Number(info.lastInsertRowid), nextPos(sessionId), ord,
      ]);
      db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
      return Number(info.lastInsertRowid);
    };
    const deleteRef = (id: number): void => {
      // 数据模型不变量：tool 消息与 owner assistant 的 tool_call 必须成对——删 tool 消息连带从 owner
      // 移除对应 tool_call（copy-on-edit）。owner 不在本会话（共享池，其他会话引用）则只删本会话引用。
      const row = getRow(id);
      if (row?.role === "tool") {
        try {
          const tm = JSON.parse(row.text) as { tool_call_id?: string };
          const tcid = tm.tool_call_id;
          if (tcid) {
            const owner = findToolOwner(sessionId, tcid);
            if (owner) {
              const calls = (owner.msg.tool_calls ?? []).filter((c) => c.id !== tcid);
              replaceWith(sessionId, owner.id, { ...owner.msg, tool_calls: calls.length ? calls : undefined });
            }
          }
        } catch { /* 旧数据行（纯文本）：跳过联动 */ }
      }
      db.run(`DELETE FROM session_messages WHERE session_id = ? AND message_id = ?`, [sessionId, id]);
    };
    const truncateRef = (fromId: number): void => {
      const o = ordOf(sessionId, fromId);
      if (o == null) return;
      db.run(`DELETE FROM session_messages WHERE session_id = ? AND ord >= ?`, [sessionId, o]);
    };

    return {
      list: () =>
        db.query(
          `SELECT m.id, m.text, m.ts FROM session_messages sm
           JOIN messages m ON m.id = sm.message_id
           WHERE sm.session_id = ? ORDER BY sm.ord`,
        ).all(sessionId)
          .map((r) => parseRow(r as { id: number; text: string; ts: string }))
          .filter((m): m is MessageRecord => m !== null),
      insert: (msg: StoredMessage) => { appendRef(msg); },
      delete: (id: number) => { deleteRef(id); },
      truncate: (fromId: number) => { truncateRef(fromId); },
      listUntil: (id: number) => {
        const o = ordOf(sessionId, id);
        if (o == null) return [];
        return db.query(
          `SELECT m.id, m.text, m.ts FROM session_messages sm
           JOIN messages m ON m.id = sm.message_id
           WHERE sm.session_id = ? AND sm.ord <= ? ORDER BY sm.ord`,
        ).all(sessionId, o)
          .map((r) => parseRow(r as { id: number; text: string; ts: string }))
          .filter((m): m is MessageRecord => m !== null);
      },
      insertAfter: (id: number, msg: StoredMessage) => insertAfterRef(id, msg),
      /** 批量编辑操作（2026-08-16 单一编辑面）：一个事务原子应用，任一 op 失败整体回滚。
       *  update 走 copy-on-edit（replaceWith）；content 置空 = ""、reasoning_content = null、
       *  tool_calls 删除连带 dropToolRef（关联 tool 消息失去挂载点）；remove 的 tool 联动在 deleteRef。 */
      applyOps: (ops: MsgOp[]) => {
        const results: (number | null)[] = [];
        try {
          db.transaction(() => {
            for (const op of ops) {
              if (op.op === "insert") {
                let after: number | null = typeof op.after === "number" ? op.after : null;
                for (const m of op.messages) {
                  const nid = after == null ? appendRef(m) : insertAfterRef(after, m);
                  if (nid == null) throw new Error(`没有这条消息: ${after}`);
                  results.push(nid);
                  after = nid; // 多消息依序连续插入
                }
                if (op.messages.length === 0) results.push(null);
              } else if (op.op === "update") {
                const old = getRow(op.id);
                if (!old) throw new Error(`没有这条消息: ${op.id}`);
                let msg: ChatMessage;
                try {
                  msg = JSON.parse(old.text) as ChatMessage;
                } catch {
                  throw new Error(`消息 ${op.id} 不是标准消息，无法编辑`);
                }
                const copy: any = structuredClone(msg);
                const removedTcIds: string[] = [];
                if (op.remove) {
                  if (op.path === "content") copy.content = ""; // 置空（交互理念：删除由显式按钮完成，消息保留）
                  else if (op.path === "reasoning_content") copy.reasoning_content = null;
                  else if (op.path === "tool_calls") {
                    for (const t of copy.tool_calls ?? []) removedTcIds.push(t.id);
                    copy.tool_calls = undefined;
                  } else if (op.path.startsWith("tool_calls/")) {
                    removedTcIds.push(op.path.split("/")[1]);
                    pathDel(copy, op.path);
                    if (Array.isArray(copy.tool_calls) && copy.tool_calls.length === 0) copy.tool_calls = undefined;
                  } else {
                    pathDel(copy, op.path);
                  }
                } else {
                  if (op.value === undefined) throw new Error("update 需要 value（或 remove: true）");
                  if (op.path === "content" || op.path === "reasoning_content" || op.path.endsWith("/arguments")) {
                    if (typeof op.value !== "string" || !op.value.trim()) throw new Error("内容不能为空");
                  }
                  if (op.path === "content") copy.content = op.value;
                  else if (op.path === "reasoning_content") copy.reasoning_content = op.value;
                  else pathSet(copy, op.path, op.value);
                }
                const nid = replaceWith(sessionId, op.id, copy);
                for (const tcid of removedTcIds) dropToolRef(sessionId, tcid);
                db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
                results.push(nid);
              } else if (op.op === "remove") {
                deleteRef(op.id);
                results.push(null);
              } else if (op.op === "truncate") {
                truncateRef(op.from);
                results.push(null);
              } else if (op.op === "move") {
                const o = ordOf(sessionId, op.id);
                if (o == null) throw new Error(`没有这条消息: ${op.id}`);
                const after = typeof op.after === "number" ? op.after : null;
                let target: string | null = null;
                for (let attempt = 0; attempt < 2 && target == null; attempt++) {
                  if (after == null) {
                    const max = (db.query(`SELECT MAX(ord) AS o FROM session_messages WHERE session_id = ?`).get(sessionId) as { o: string | null }).o ?? "";
                    if (o === max) { target = o; break; } // 已在末尾 = 无操作
                    target = appendKey(max); // 严格大于当前最大；appendKey 恒产出新键，不会撞 UNIQUE
                  } else {
                    const ao = ordOf(sessionId, after);
                    if (ao == null) throw new Error(`没有这条消息: ${after}`);
                    if (ao === o) { target = o; break; } // 移到自身之后 = 无操作
                    const next = db.query(
                      `SELECT ord FROM session_messages WHERE session_id = ? AND ord > ? AND ord != ? ORDER BY ord LIMIT 1`,
                    ).all(sessionId, ao, o) as { ord: string }[];
                    const k = midKey(ao, next[0]?.ord ?? "");
                    if (k != null && k > ao && (next.length === 0 || k < next[0].ord)) {
                      target = k;
                      break;
                    }
                    rebalance(sessionId); // 键空间不足（罕见）：整表重排后重试
                  }
                }
                if (target == null) throw new Error("键空间不足：重排后仍无法移动（理论不可达）");
                if (target !== o) {
                  db.run(`UPDATE session_messages SET ord = ? WHERE session_id = ? AND message_id = ?`, [target, sessionId, op.id]);
                  db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
                }
                results.push(null);
              } else {
                throw new Error(`未知操作: ${(op as { op: string }).op}`);
              }
            }
          })();
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        return { results };
      },
    };
  };

  return {
    session: (id: string) => {
      ensureSession(id);
      return sessionView(id);
    },
    createSession: (name: string, forkId?: string, atMessageId?: number, settingsFrom?: string) => {
      const nm = name.trim() || "会话";
      let id = nm.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!id) id = "session";
      const taken = (candidate: string) => !!db.query(`SELECT id FROM sessions WHERE id = ?`).get(candidate);
      const base = id;
      let n = 1;
      while (taken(id)) {
        n += 1;
        id = `${base}-${n}`;
      }
      if (forkId && !taken(forkId)) return { error: `没有这个会话: ${forkId}` };
      // 分叉截止点：atMessageId 给定时新会话只含该消息及之前的引用（"从这条消息分叉"）
      let forkOrd: string | null = null;
      if (forkId && atMessageId != null) {
        forkOrd = ordOf(forkId, atMessageId);
        if (forkOrd == null) return { error: `会话 ${forkId} 里没有这条消息` };
      }
      // 设置继承：settingsFrom 给定时复制该会话的 provider/model（新建会话沿用当前会话的选择）；
      // 源会话没有记录时写入持久化的全局选择——新会话总是带着当前选择的模型（不回落 NULL 跟随后续变化）
      const srcModel = settingsFrom && taken(settingsFrom)
        ? (db.query(`SELECT provider_id, model_id FROM sessions WHERE id = ?`).get(settingsFrom) as
            { provider_id: string | null; model_id: string | null })
        : null;
      const src = srcModel?.provider_id ? srcModel : null; // 会话记录（provider_id 风格）
      const g = !src ? readGlobalModel() : null; // 全局记录（providerId 风格）
      const t = now();
      db.run(
        `INSERT INTO sessions (id, name, created, updated, provider_id, model_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, nm, t, t, src?.provider_id ?? g?.providerId ?? null, src?.model_id ?? g?.modelId ?? null],
      );
      if (forkId) {
        if (forkOrd != null) {
          db.run(
            `INSERT INTO session_messages (session_id, message_id, pos, ord)
             SELECT ?, message_id, pos, ord FROM session_messages WHERE session_id = ? AND ord <= ?`,
            [id, forkId, forkOrd],
          );
        } else {
          db.run(
            `INSERT INTO session_messages (session_id, message_id, pos, ord)
             SELECT ?, message_id, pos, ord FROM session_messages WHERE session_id = ?`,
            [id, forkId],
          );
        }
      }
      return { id };
    },
    listSessions: () => {
      const rows = db.query(
        `SELECT s.id, s.name, s.created, s.updated,
                (SELECT COUNT(*) FROM session_messages sm WHERE sm.session_id = s.id) AS count,
                (SELECT m.text FROM session_messages sm JOIN messages m ON m.id = sm.message_id
                 WHERE sm.session_id = s.id AND m.role IN ('user','assistant','agent') ORDER BY sm.ord DESC LIMIT 1) AS preview
         FROM sessions s ORDER BY s.updated DESC`,
      ).all() as Array<{ id: string; name: string; created: string; updated: string; count: number; preview: string | null }>;
      return rows.map((r) => {
        let text = r.preview;
        if (text) {
          try {
            text = (JSON.parse(text) as { content?: string }).content ?? text;
          } catch { /* 旧数据纯文本行：原样预览 */ }
        }
        return {
          ...r,
          count: Number(r.count),
          preview: text != null && text.length > 120 ? `${text.slice(0, 120)}…` : text,
        };
      }) as SessionInfo[];
    },
    deleteSession: (id: string) => {
      // default 也可删：它是"按需重建的锚点"——无 session 请求（resolveSession 缺省 default）会自动重建空的
      if (!db.query(`SELECT id FROM sessions WHERE id = ?`).get(id)) return `没有这个会话: ${id}`;
      db.run(`DELETE FROM session_messages WHERE session_id = ?`, [id]);
      db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
      return null;
    },
    sessionModel: (id: string) => {
      const row = db.query(`SELECT provider_id, model_id FROM sessions WHERE id = ?`).get(id) as
        { provider_id: string | null; model_id: string | null } | null;
      if (!row || !row.provider_id || !row.model_id) return null;
      return { providerId: row.provider_id, modelId: row.model_id };
    },
    setSessionModel: (id: string, providerId: string, modelId: string) => {
      ensureSession(id);
      db.run(`UPDATE sessions SET provider_id = ?, model_id = ? WHERE id = ?`, [providerId, modelId, id]);
    },
    getGlobalModel: () => readGlobalModel(),
    setGlobalModel: writeGlobalModel,
    exportSession: (id: string) => {
      if (!db.query(`SELECT id FROM sessions WHERE id = ?`).get(id)) return null;
      const rows = db.query(
        `SELECT m.id, m.text, m.ts FROM session_messages sm
         JOIN messages m ON m.id = sm.message_id
         WHERE sm.session_id = ? ORDER BY sm.ord`,
      ).all(id) as { id: number; text: string; ts: string }[];
      return rows.map((r) => {
        const parsed = parseRow(r);
        return JSON.stringify(parsed ?? { id: r.id, ts: r.ts, text: r.text }); // 旧数据行原样导出
      }).join("\n");
    },
  };
}
