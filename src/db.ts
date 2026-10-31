import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Agent, AgentStatus, AgentType, ContextHistory, ContextItem, Message, Room } from './types.js';

export class AextingDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string = 'aexting.db') {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        tunnel_url TEXT
      );

      CREATE TABLE IF NOT EXISTS agents (
        name TEXT NOT NULL,
        room_code TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        status TEXT NOT NULL,
        current_task TEXT,
        joined_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (name, room_code)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        is_private INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_pool (
        key TEXT NOT NULL,
        room_code TEXT NOT NULL,
        section TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (key, room_code)
      );

      CREATE TABLE IF NOT EXISTS context_history (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        key TEXT NOT NULL,
        section TEXT NOT NULL,
        old_content TEXT,
        new_content TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_code, timestamp);
      CREATE INDEX IF NOT EXISTS idx_agents_room ON agents(room_code);
      CREATE INDEX IF NOT EXISTS idx_context_room ON context_pool(room_code);
    `);
  }

  public normalizeName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '@agent';
    return trimmed.startsWith('@') ? trimmed.toLowerCase() : `@${trimmed.toLowerCase()}`;
  }

  // --- ROOMS ---

  public createRoom(code: string, hostName: string, tunnelUrl?: string): Room {
    const existing = this.getRoom(code);
    if (existing) return existing;

    const createdAt = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO rooms (code, host_name, created_at, tunnel_url)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(code, hostName, createdAt, tunnelUrl || null);

    return {
      code,
      hostName,
      createdAt,
      tunnelUrl,
    };
  }

  public getRoom(code: string): Room | null {
    const stmt = this.db.prepare(`SELECT * FROM rooms WHERE code = ?`);
    const row = stmt.get(code) as any;
    if (!row) return null;
    return {
      code: row.code,
      hostName: row.host_name,
      createdAt: row.created_at,
      tunnelUrl: row.tunnel_url || undefined,
    };
  }

  public updateRoomTunnel(code: string, tunnelUrl: string) {
    const stmt = this.db.prepare(`UPDATE rooms SET tunnel_url = ? WHERE code = ?`);
    stmt.run(tunnelUrl, code);
  }

  // --- AGENTS ---

  public upsertAgent(
    roomCode: string,
    rawName: string,
    agentType: AgentType = 'custom',
    status: AgentStatus = 'idle',
    currentTask?: string
  ): Agent {
    const name = this.normalizeName(rawName);
    const now = Date.now();

    const existingStmt = this.db.prepare(`SELECT joined_at FROM agents WHERE name = ? AND room_code = ?`);
    const existing = existingStmt.get(name, roomCode) as any;
    const joinedAt = existing ? existing.joined_at : now;

    const stmt = this.db.prepare(`
      INSERT INTO agents (name, room_code, agent_type, status, current_task, joined_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name, room_code) DO UPDATE SET
        agent_type = excluded.agent_type,
        status = excluded.status,
        current_task = excluded.current_task,
        last_seen = excluded.last_seen
    `);

    stmt.run(name, roomCode, agentType, status, currentTask || null, joinedAt, now);

    return {
      name,
      roomCode,
      agentType,
      status,
      currentTask,
      joinedAt,
      lastSeen: now,
    };
  }

  public updateAgentHeartbeat(roomCode: string, rawName: string, status?: AgentStatus, currentTask?: string) {
    const name = this.normalizeName(rawName);
    const now = Date.now();

    if (status || currentTask !== undefined) {
      const stmt = this.db.prepare(`
        UPDATE agents 
        SET last_seen = ?, 
            status = COALESCE(?, status), 
            current_task = COALESCE(?, current_task)
        WHERE name = ? AND room_code = ?
      `);
      stmt.run(now, status || null, currentTask || null, name, roomCode);
    } else {
      const stmt = this.db.prepare(`UPDATE agents SET last_seen = ? WHERE name = ? AND room_code = ?`);
      stmt.run(now, name, roomCode);
    }
  }

  public getAgents(roomCode: string): Agent[] {
    const stmt = this.db.prepare(`SELECT * FROM agents WHERE room_code = ? ORDER BY last_seen DESC`);
    const rows = stmt.all(roomCode) as any[];
    return rows.map((r) => ({
      name: r.name,
      roomCode: r.room_code,
      agentType: r.agent_type,
      status: r.status,
      currentTask: r.current_task || undefined,
      joinedAt: r.joined_at,
      lastSeen: r.last_seen,
    }));
  }

  public getAgent(roomCode: string, rawName: string): Agent | null {
    const name = this.normalizeName(rawName);
    const stmt = this.db.prepare(`SELECT * FROM agents WHERE name = ? AND room_code = ?`);
    const r = stmt.get(name, roomCode) as any;
    if (!r) return null;
    return {
      name: r.name,
      roomCode: r.room_code,
      agentType: r.agent_type,
      status: r.status,
      currentTask: r.current_task || undefined,
      joinedAt: r.joined_at,
      lastSeen: r.last_seen,
    };
  }

  public removeAgent(roomCode: string, rawName: string) {
    const name = this.normalizeName(rawName);
    const stmt = this.db.prepare(`DELETE FROM agents WHERE name = ? AND room_code = ?`);
    stmt.run(name, roomCode);
  }

  // --- MESSAGES ---

  public saveMessage(
    roomCode: string,
    senderRaw: string,
    senderType: AgentType,
    recipientRaw: string,
    content: string,
    tags: string[] = []
  ): Message {
    const id = randomUUID();
    const senderName = this.normalizeName(senderRaw);
    const recipientName = recipientRaw.toLowerCase() === '@all' ? '@all' : this.normalizeName(recipientRaw);
    const isPrivate = recipientName !== '@all';
    const timestamp = Date.now();

    // Also auto-extract tags like #bug, #urgent, #decision if present
    const extractedTags = [...tags];
    const hashMatches = content.match(/#[a-zA-Z0-9_\-]+/g);
    if (hashMatches) {
      for (const t of hashMatches) {
        if (!extractedTags.includes(t)) extractedTags.push(t);
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, room_code, sender_name, sender_type, recipient_name, content, tags, is_private, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      roomCode,
      senderName,
      senderType,
      recipientName,
      content,
      JSON.stringify(extractedTags),
      isPrivate ? 1 : 0,
      timestamp
    );

    return {
      id,
      roomCode,
      senderName,
      senderType,
      recipientName,
      content,
      tags: extractedTags,
      isPrivate,
      timestamp,
    };
  }

  public getMessages(
    roomCode: string,
    options: {
      forAgent?: string;
      since?: number;
      limit?: number;
      includeAllPrivateForObserver?: boolean;
    } = {}
  ): Message[] {
    const { forAgent, since = 0, limit = 100, includeAllPrivateForObserver = false } = options;

    let query: string;
    let params: any[];

    if (includeAllPrivateForObserver || !forAgent) {
      // Return all messages in room (for human dashboard / observer)
      query = `
        SELECT * FROM messages 
        WHERE room_code = ? AND timestamp > ?
        ORDER BY timestamp ASC
        LIMIT ?
      `;
      params = [roomCode, since, limit];
    } else {
      // Filter for specific agent: message to agent, from agent, or broadcast to @all
      const normalizedAgent = this.normalizeName(forAgent);
      query = `
        SELECT * FROM messages 
        WHERE room_code = ? AND timestamp > ?
          AND (recipient_name = '@all' OR recipient_name = ? OR sender_name = ?)
        ORDER BY timestamp ASC
        LIMIT ?
      `;
      params = [roomCode, since, normalizedAgent, normalizedAgent, limit];
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map((r) => ({
      id: r.id,
      roomCode: r.room_code,
      senderName: r.sender_name,
      senderType: r.sender_type,
      recipientName: r.recipient_name,
      content: r.content,
      tags: JSON.parse(r.tags || '[]'),
      isPrivate: r.is_private === 1,
      timestamp: r.timestamp,
    }));
  }

  // --- GLOBAL CONTEXT POOL ---

  public setContext(
    roomCode: string,
    key: string,
    section: string = 'general',
    content: string,
    updatedByRaw: string
  ): ContextItem {
    const updatedBy = this.normalizeName(updatedByRaw);
    const now = Date.now();

    const existingStmt = this.db.prepare(`SELECT content, version FROM context_pool WHERE key = ? AND room_code = ?`);
    const existing = existingStmt.get(key, roomCode) as any;

    const oldContent = existing ? existing.content : '';
    const newVersion = existing ? existing.version + 1 : 1;

    const stmt = this.db.prepare(`
      INSERT INTO context_pool (key, room_code, section, content, updated_by, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key, room_code) DO UPDATE SET
        section = excluded.section,
        content = excluded.content,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        version = excluded.version
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      stmt.run(key, roomCode, section, content, updatedBy, now, newVersion);
      // Record in history audit log
      const historyStmt = this.db.prepare(`
        INSERT INTO context_history (id, room_code, key, section, old_content, new_content, updated_by, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      historyStmt.run(randomUUID(), roomCode, key, section, oldContent, content, updatedBy, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      key,
      roomCode,
      section,
      content,
      updatedBy,
      updatedAt: now,
      version: newVersion,
    };
  }

  public appendContext(
    roomCode: string,
    key: string,
    section: string = 'general',
    entry: string,
    updatedByRaw: string
  ): ContextItem {
    const existing = this.getContextByKey(roomCode, key);
    let newContent: string;
    if (existing && existing.content.trim()) {
      newContent = `${existing.content}\n${entry}`;
    } else {
      newContent = entry;
    }
    return this.setContext(roomCode, key, section || (existing?.section ?? 'general'), newContent, updatedByRaw);
  }

  public getAllContext(roomCode: string): ContextItem[] {
    const stmt = this.db.prepare(`SELECT * FROM context_pool WHERE room_code = ? ORDER BY section ASC, key ASC`);
    const rows = stmt.all(roomCode) as any[];
    return rows.map((r) => ({
      key: r.key,
      roomCode: r.room_code,
      section: r.section,
      content: r.content,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      version: r.version,
    }));
  }

  public getContextByKey(roomCode: string, key: string): ContextItem | null {
    const stmt = this.db.prepare(`SELECT * FROM context_pool WHERE key = ? AND room_code = ?`);
    const r = stmt.get(key, roomCode) as any;
    if (!r) return null;
    return {
      key: r.key,
      roomCode: r.room_code,
      section: r.section,
      content: r.content,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      version: r.version,
    };
  }

  public deleteContext(roomCode: string, key: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM context_pool WHERE key = ? AND room_code = ?`);
    stmt.run(key, roomCode);
    return true;
  }

  public getContextHistory(roomCode: string, limit = 50): ContextHistory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM context_history 
      WHERE room_code = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    const rows = stmt.all(roomCode, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      roomCode: r.room_code,
      key: r.key,
      section: r.section,
      oldContent: r.old_content || '',
      newContent: r.new_content,
      updatedBy: r.updated_by,
      timestamp: r.timestamp,
    }));
  }
}

export const NexusDatabase = AextingDatabase;

