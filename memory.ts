import { Database } from "bun:sqlite";
import type { MemoryStore, MessageRecord, SessionInfo, SessionStore } from "./types";

// 默认记忆组件：SQLite 消息历史（DB_PATH 由 daemon 注入）—— 进程可被随便换血，历史一条不丢。

export function sqliteMemory(dbPath: string | undefined): MemoryStore {
  const db = new Database(dbPath ?? ":memory:", { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts TEXT NOT NULL
  )`);
  return {
    list: () =>
      db.query("SELECT id, role, text, ts FROM messages ORDER BY id").all() as MessageRecord[],
    insert: (role: string, text: string) => {
      db.run("INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)", [role, text, new Date().toISOString()]);
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
// 多会话共享零复制——共享靠引用而非结构：前缀/中间/后缀消息都能被任意会话引用；
// 删除/截断/删会话都是"删引用"，消息行留在池里（孤儿，可恢复），彻底清除留给将来的 purge。
// 流代码不用改：session(id) 返回 MemoryStore 视图，loadHistory/saveHistory 照常。
// 旧数据兼容：messages 表形状不变，首次启动自动迁移为 default 会话（无 session 的请求都落在它上面）。

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
  // 迁移：旧库的 sessions 表没有模型列（ALTER 补上；新库建表已含）
  const sessionCols = db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "provider_id")) {
    db.run(`ALTER TABLE sessions ADD COLUMN provider_id TEXT`);
    db.run(`ALTER TABLE sessions ADD COLUMN model_id TEXT`);
  }
  db.run(`CREATE TABLE IF NOT EXISTS session_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    pos INTEGER NOT NULL,
    PRIMARY KEY (session_id, message_id),
    UNIQUE (session_id, pos)
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

  const posOf = (sessionId: string, messageId: number): number | null => {
    const row = db.query(`SELECT pos FROM session_messages WHERE session_id = ? AND message_id = ?`).get(sessionId, messageId) as { pos: number } | null;
    return row ? row.pos : null;
  };

  const nextPos = (sessionId: string): number => {
    const row = db.query(`SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM session_messages WHERE session_id = ?`).get(sessionId) as { p: number };
    return row.p;
  };

  const sessionView = (sessionId: string): MemoryStore => ({
    list: () =>
      db.query(
        `SELECT m.id, m.role, m.text, m.ts FROM session_messages sm
         JOIN messages m ON m.id = sm.message_id
         WHERE sm.session_id = ? ORDER BY sm.pos`,
      ).all(sessionId) as MessageRecord[],
    insert: (role: string, text: string) => {
      const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [role, text, now()]);
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
        `SELECT m.id, m.role, m.text, m.ts FROM session_messages sm
         JOIN messages m ON m.id = sm.message_id
         WHERE sm.session_id = ? AND sm.pos <= ? ORDER BY sm.pos`,
      ).all(sessionId, pos) as MessageRecord[];
    },
    insertAfter: (id: number, role: string, text: string) => {
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
        const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [role, text, now()]);
        db.run(`INSERT INTO session_messages (session_id, message_id, pos) VALUES (?, ?, ?)`, [
          sessionId, Number(info.lastInsertRowid), pos + 1,
        ]);
        return Number(info.lastInsertRowid);
      })();
      db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
      return newId;
    },
    updateText: (id: number, text: string) => {
      const old = db.query(`SELECT role, ts FROM messages WHERE id = ?`).get(id) as { role: string; ts: string } | null;
      if (!old) return null;
      // copy-on-edit：池不可变，新建一行替换本会话的引用；共享该消息的其他会话仍指原行
      const info = db.run(`INSERT INTO messages (role, text, ts) VALUES (?, ?, ?)`, [old.role, text, old.ts]);
      db.run(`UPDATE session_messages SET message_id = ? WHERE session_id = ? AND message_id = ?`, [
        Number(info.lastInsertRowid), sessionId, id,
      ]);
      db.run(`UPDATE sessions SET updated = ? WHERE id = ?`, [now(), sessionId]);
      return Number(info.lastInsertRowid);
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
      // 设置继承：settingsFrom 给定时复制该会话的 provider/model（新建会话沿用当前会话的选择）
      const srcModel = settingsFrom && taken(settingsFrom)
        ? (db.query(`SELECT provider_id, model_id FROM sessions WHERE id = ?`).get(settingsFrom) as
            { provider_id: string | null; model_id: string | null })
        : null;
      const t = now();
      db.run(
        `INSERT INTO sessions (id, name, created, updated, provider_id, model_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, nm, t, t, srcModel?.provider_id ?? null, srcModel?.model_id ?? null],
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
                 WHERE sm.session_id = s.id AND m.role IN ('user','agent') ORDER BY sm.pos DESC LIMIT 1) AS preview
         FROM sessions s ORDER BY s.updated DESC`,
      ).all() as Array<{ id: string; name: string; created: string; updated: string; count: number; preview: string | null }>;
      return rows.map((r) => ({
        ...r,
        count: Number(r.count),
        preview: r.preview != null && r.preview.length > 120 ? `${r.preview.slice(0, 120)}…` : r.preview,
      })) as SessionInfo[];
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
    exportSession: (id: string) => {
      if (!db.query(`SELECT id FROM sessions WHERE id = ?`).get(id)) return null;
      const rows = db.query(
        `SELECT m.id, m.role, m.text, m.ts FROM session_messages sm
         JOIN messages m ON m.id = sm.message_id
         WHERE sm.session_id = ? ORDER BY sm.pos`,
      ).all(id) as MessageRecord[];
      return rows.map((m) => JSON.stringify(m)).join("\n");
    },
  };
}
