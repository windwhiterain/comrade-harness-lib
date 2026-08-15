import { Database } from "bun:sqlite";
import type { ChatMessage, MemoryStore, MessageRecord, SessionInfo, SessionStore, StoredMessage } from "./types";

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
    PRIMARY KEY (session_id, message_id),
    UNIQUE (session_id, pos)
  )`);
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
    db.run(`INSERT INTO session_messages (session_id, message_id, pos) SELECT 'default', id, id FROM messages`);
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

  const posOf = (sessionId: string, messageId: number): number | null => {
    const row = db.query(`SELECT pos FROM session_messages WHERE session_id = ? AND message_id = ?`).get(sessionId, messageId) as { pos: number } | null;
    return row ? row.pos : null;
  };

  const nextPos = (sessionId: string): number => {
    const row = db.query(`SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM session_messages WHERE session_id = ?`).get(sessionId) as { p: number };
    return row.p;
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
       WHERE sm.session_id = ? AND m.role = 'assistant' ORDER BY sm.pos`,
    ).all(sessionId) as { id: number; text: string }[];
    for (const r of rows) {
      try {
        const m = JSON.parse(r.text) as ChatMessage;
        if (m.tool_calls?.some((c) => c.id === toolCallId)) return { id: r.id, msg: m };
      } catch { /* 旧数据行：跳过 */ }
    }
    return null;
  };

  const sessionView = (sessionId: string): MemoryStore => ({
    list: () =>
      db.query(
        `SELECT m.id, m.text, m.ts FROM session_messages sm
         JOIN messages m ON m.id = sm.message_id
         WHERE sm.session_id = ? ORDER BY sm.pos`,
      ).all(sessionId)
        .map((r) => parseRow(r as { id: number; text: string; ts: string }))
        .filter((m): m is MessageRecord => m !== null),
    insert: (msg: StoredMessage) => {
      const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [msg.role, JSON.stringify(msg), now()]);
      const id = Number(info.lastInsertRowid);
      db.run(`INSERT INTO session_messages (session_id, message_id, pos) VALUES (?, ?, ?)`, [sessionId, id, nextPos(sessionId)]);
      db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
    },
    delete: (id: number) => {
      db.run(`DELETE FROM session_messages WHERE session_id = ? AND message_id = ?`, [sessionId, id]);
    },
    truncate: (fromId: number) => {
      const pos = posOf(sessionId, fromId);
      if (pos == null) return;
      db.run(`DELETE FROM session_messages WHERE session_id = ? AND pos >= ?`, [sessionId, pos]);
    },
    listUntil: (id: number) => {
      const pos = posOf(sessionId, id);
      if (pos == null) return [];
      return db.query(
        `SELECT m.id, m.text, m.ts FROM session_messages sm
         JOIN messages m ON m.id = sm.message_id
         WHERE sm.session_id = ? AND sm.pos <= ? ORDER BY sm.pos`,
      ).all(sessionId, pos)
        .map((r) => parseRow(r as { id: number; text: string; ts: string }))
        .filter((m): m is MessageRecord => m !== null);
    },
    insertAfter: (id: number, msg: StoredMessage) => {
      const pos = posOf(sessionId, id);
      if (pos == null) return null;
      // 中间插入：后续引用的 pos 整体 +1 腾位。不能直接 UPDATE pos = pos + 1——
      // UNIQUE(session_id,pos) 逐行检查，升序更新必然撞"新值已被未更新的行占用"。
      // 事务内先删引用再按新 pos 重插：中间态没有唯一性冲突，原子完成。
      const newId = db.transaction(() => {
        const rows = db.query(
          `SELECT message_id FROM session_messages WHERE session_id = ? AND pos > ? ORDER BY pos`,
        ).all(sessionId, pos) as { message_id: number }[];
        db.run(`DELETE FROM session_messages WHERE session_id = ? AND pos > ?`, [sessionId, pos]);
        rows.forEach((r, i) => {
          db.run(`INSERT INTO session_messages (session_id, message_id, pos) VALUES (?, ?, ?)`, [
            sessionId, r.message_id, pos + 2 + i,
          ]);
        });
        const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [msg.role, JSON.stringify(msg), now()]);
        db.run(`INSERT INTO session_messages (session_id, message_id, pos) VALUES (?, ?, ?)`, [
          sessionId, Number(info.lastInsertRowid), pos + 1,
        ]);
        return Number(info.lastInsertRowid);
      })();
      db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
      return newId;
    },
    updateField: (id: number, field: "content" | "reasoning" | "args" | "tool", text: string, toolCallId?: string) => {
      const old = getRow(id);
      if (!old) return null;
      let msg: ChatMessage;
      try {
        msg = JSON.parse(old.text) as ChatMessage;
      } catch {
        return null; // 旧数据（纯文本行）：不支持修改
      }
      if (field === "content") return replaceWith(sessionId, id, { ...msg, content: text });
      if (field === "reasoning") return replaceWith(sessionId, id, { ...msg, reasoning_content: text });
      if (field === "args") {
        const calls = msg.tool_calls ?? [];
        if (!calls.some((c) => c.id === toolCallId)) return null; // 没有这个 tool_call
        return replaceWith(sessionId, id, {
          ...msg,
          tool_calls: calls.map((c) =>
            c.id === toolCallId ? { ...c, function: { ...c.function, arguments: text } } : c,
          ),
        });
      }
      if (field === "tool") return replaceWith(sessionId, id, { ...msg, content: text });
      return null;
    },
    clearField: (id: number, field: "reasoning" | "content" | "tool_calls" | "tool", toolCallId?: string) => {
      const old = getRow(id);
      if (!old) return null;
      // tool 侧删除（id = tool 消息）：删引用 + 对应 assistant 的 tool_call 一并移除（双向联动）
      if (field === "tool") {
        let tm: ChatMessage;
        try {
          tm = JSON.parse(old.text) as ChatMessage;
        } catch {
          return null; // 旧数据（纯文本行）：不支持
        }
        const tcid = (tm as ChatMessage & { tool_call_id?: string }).tool_call_id;
        if (!tcid) return null;
        db.run(`DELETE FROM session_messages WHERE session_id = ? AND message_id = ?`, [sessionId, id]);
        const owner = findToolOwner(sessionId, tcid);
        if (owner) {
          const calls = (owner.msg.tool_calls ?? []).filter((c) => c.id !== tcid);
          replaceWith(sessionId, owner.id, { ...owner.msg, tool_calls: calls.length ? calls : undefined });
        }
        db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
        return "updated";
      }
      let msg: ChatMessage;
      try {
        msg = JSON.parse(old.text) as ChatMessage;
      } catch {
        return null; // 旧数据（纯文本行）：不支持字段删除
      }
      // 置空（删除 = 置为空）：
      const cleared: ChatMessage = { ...msg };
      if (field === "reasoning") cleared.reasoning_content = null;
      else if (field === "content") cleared.content = "";
      else if (field === "tool_calls") {
        // 单个 tool_call 删除（UI 的 tool call 小框"删除"）：只移除该 id；无 toolCallId = 清空全部
        const rest = toolCallId != null ? (msg.tool_calls ?? []).filter((c) => c.id !== toolCallId) : [];
        cleared.tool_calls = toolCallId != null ? (rest.length ? rest : undefined) : undefined;
      }
      // 字段全空也保留消息（交互理念：删除由显式按钮完成，字段置空只清内容，不自动删消息）
      replaceWith(sessionId, id, cleared);
      // 清空 tool_calls：关联的 tool 结果消息失去挂载点（协议上 tool 消息必须跟在 assistant 的
      // tool_calls 下），连带删除本会话中这些 tool 消息的引用——用户点"删除工具" = 删掉整个工具活动
      if (field === "tool_calls" && msg.tool_calls?.length) {
        if (toolCallId != null) dropToolRef(sessionId, toolCallId);
        else for (const t of msg.tool_calls) dropToolRef(sessionId, t.id);
      }
      db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
      return "updated";
    },
  });

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
      let forkPos: number | null = null;
      if (forkId && atMessageId != null) {
        forkPos = posOf(forkId, atMessageId);
        if (forkPos == null) return { error: `会话 ${forkId} 里没有这条消息` };
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
        if (forkPos != null) {
          db.run(
            `INSERT INTO session_messages (session_id, message_id, pos)
             SELECT ?, message_id, pos FROM session_messages WHERE session_id = ? AND pos <= ?`,
            [id, forkId, forkPos],
          );
        } else {
          db.run(
            `INSERT INTO session_messages (session_id, message_id, pos)
             SELECT ?, message_id, pos FROM session_messages WHERE session_id = ?`,
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
                 WHERE sm.session_id = s.id AND m.role IN ('user','assistant','agent') ORDER BY sm.pos DESC LIMIT 1) AS preview
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
         WHERE sm.session_id = ? ORDER BY sm.pos`,
      ).all(id) as { id: number; text: string; ts: string }[];
      return rows.map((r) => {
        const parsed = parseRow(r);
        return JSON.stringify(parsed ?? { id: r.id, ts: r.ts, text: r.text }); // 旧数据行原样导出
      }).join("\n");
    },
  };
}
