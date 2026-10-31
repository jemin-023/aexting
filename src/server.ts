import express, { Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { AextingDatabase, NexusDatabase } from './db.js';
import { createPublicTunnel, getLanIps } from './tunnel.js';
import type {
  Agent,
  AgentStatus,
  AgentType,
  ContextItem,
  Message,
  Room,
  WSClientMessage,
  WSServerMessage,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerOptions {
  port?: number;
  host?: string;
  roomCode?: string;
  hostName?: string;
  enableTunnel?: boolean;
  tunnelToken?: string;
  publicUrl?: string;
  dbPath?: string;
}

interface SocketClient {
  ws: WebSocket;
  roomCode?: string;
  agentName?: string;
  agentType?: AgentType;
  isAlive: boolean;
}

export class AextingServer {
  public app: express.Express;
  public server: ReturnType<typeof createServer>;
  public wss: WebSocketServer;
  public db: AextingDatabase;
  public port: number;
  public host: string;
  public roomCode: string;
  public hostName: string;
  public enableTunnel: boolean;
  public tunnelToken?: string;
  public publicUrl?: string;
  public tunnelClose?: () => Promise<void>;

  private clients: Set<SocketClient> = new Set();
  private sseClients: Map<string, { res: Response; roomCode: string; agentName: string }> = new Map();

  constructor(options: ServerOptions = {}) {
    this.port = options.port || parseInt(process.env.PORT || '7331', 10);
    this.host = options.host || '0.0.0.0';
    this.roomCode = (
      options.roomCode ||
      process.env.AEXTING_ROOM ||
      process.env.NEXUS_ROOM ||
      this.generateRoomCode()
    ).toUpperCase();
    this.hostName = options.hostName || 'Aexting-Host';
    this.enableTunnel = options.enableTunnel ?? false;
    this.tunnelToken = options.tunnelToken || process.env.CLOUDFLARE_TUNNEL_TOKEN;
    this.publicUrl = options.publicUrl || process.env.AEXTING_PUBLIC_URL || process.env.NEXUS_PUBLIC_URL;

    this.db = new AextingDatabase(options.dbPath || 'aexting.db');

    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.setupExpress();
    this.setupWebSockets();
    this.setupHeartbeat();
  }

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'AEXT-';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  private setupExpress() {
    this.app.use(cors());
    this.app.use(express.json());

    // Serve static files for WhatsApp-style Web UI
    const publicPath = path.resolve(__dirname, '../public');
    this.app.use(express.static(publicPath));

    // --- REST API ---

    // 1. Room info / handshake
    this.app.get('/api/pool/info', (req: Request, res: Response) => {
      const room = this.db.getRoom(this.roomCode);
      const agents = this.db.getAgents(this.roomCode);
      const lanIps = getLanIps();

      res.json({
        roomCode: this.roomCode,
        hostName: this.hostName,
        createdAt: room?.createdAt || Date.now(),
        tunnelUrl: this.publicUrl || room?.tunnelUrl,
        lanUrls: lanIps.map((ip) => `http://${ip}:${this.port}`),
        localUrl: `http://localhost:${this.port}`,
        activeAgents: agents.filter((a) => Date.now() - a.lastSeen < 60000).length,
        totalAgents: agents.length,
      });
    });

    // 2. Register/Join agent
    this.app.post('/api/pool/join', (req: Request, res: Response) => {
      const { roomCode, name, agentType = 'custom', status = 'idle', currentTask } = req.body;
      const targetRoom = (roomCode || this.roomCode).toUpperCase();

      if (targetRoom !== this.roomCode) {
        return res.status(404).json({ error: `Room ${targetRoom} not found on this host.` });
      }

      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Agent name is required.' });
      }

      const agent = this.db.upsertAgent(targetRoom, name, agentType, status, currentTask);
      this.broadcastToRoom(targetRoom, { type: 'agent_joined', agent });

      const room = this.db.getRoom(targetRoom);
      const allAgents = this.db.getAgents(targetRoom);
      const context = this.db.getAllContext(targetRoom);
      const recentMessages = this.db.getMessages(targetRoom, { forAgent: agent.name, limit: 50 });

      res.json({
        success: true,
        agent,
        room,
        agents: allAgents,
        context,
        recentMessages,
      });
    });

    // 3. List agents
    this.app.get('/api/pool/agents', (req: Request, res: Response) => {
      const roomCode = ((req.query.roomCode as string) || this.roomCode).toUpperCase();
      const agents = this.db.getAgents(roomCode);
      res.json({ agents });
    });

    // 4. Send Message (Direct DM or Broadcast @all)
    this.app.post('/api/messages', (req: Request, res: Response) => {
      const { roomCode, from, to = '@all', content, tags = [], agentType = 'custom' } = req.body;
      const targetRoom = (roomCode || this.roomCode).toUpperCase();

      if (!from || !content) {
        return res.status(400).json({ error: 'Both "from" and "content" are required.' });
      }

      const msg = this.db.saveMessage(targetRoom, from, agentType, to, content, tags);

      // Dispatch real-time via WebSocket and SSE
      this.dispatchMessage(msg);

      res.json({ success: true, message: msg });
    });

    // 5. Query Messages
    this.app.get('/api/messages', (req: Request, res: Response) => {
      const roomCode = ((req.query.roomCode as string) || this.roomCode).toUpperCase();
      const forAgent = req.query.forAgent as string | undefined;
      const since = req.query.since ? parseInt(req.query.since as string, 10) : 0;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const observer = req.query.observer === 'true';

      const messages = this.db.getMessages(roomCode, {
        forAgent,
        since,
        limit,
        includeAllPrivateForObserver: observer,
      });

      res.json({ messages });
    });

    // 6. Global Context: Get
    this.app.get('/api/context', (req: Request, res: Response) => {
      const roomCode = ((req.query.roomCode as string) || this.roomCode).toUpperCase();
      const key = req.query.key as string | undefined;

      if (key) {
        const item = this.db.getContextByKey(roomCode, key);
        if (!item) return res.status(404).json({ error: `Context key "${key}" not found.` });
        return res.json({ item });
      }

      const context = this.db.getAllContext(roomCode);
      res.json({ context });
    });

    // 7. Global Context: Set
    this.app.post('/api/context', (req: Request, res: Response) => {
      const { roomCode, key, section = 'general', content, updatedBy = '@system' } = req.body;
      const targetRoom = (roomCode || this.roomCode).toUpperCase();

      if (!key || content === undefined) {
        return res.status(400).json({ error: 'Both "key" and "content" are required.' });
      }

      const item = this.db.setContext(targetRoom, key, section, String(content), updatedBy);
      this.broadcastToRoom(targetRoom, { type: 'context_updated', item, updatedBy });

      res.json({ success: true, item });
    });

    // 8. Global Context: Append
    this.app.post('/api/context/append', (req: Request, res: Response) => {
      const { roomCode, key, section = 'general', entry, updatedBy = '@system' } = req.body;
      const targetRoom = (roomCode || this.roomCode).toUpperCase();

      if (!key || !entry) {
        return res.status(400).json({ error: 'Both "key" and "entry" are required.' });
      }

      const item = this.db.appendContext(targetRoom, key, section, String(entry), updatedBy);
      this.broadcastToRoom(targetRoom, { type: 'context_updated', item, updatedBy });

      res.json({ success: true, item });
    });

    // 9. Global Context: Delete
    this.app.delete('/api/context', (req: Request, res: Response) => {
      const { roomCode, key } = req.body;
      const targetRoom = (roomCode || this.roomCode).toUpperCase();

      if (!key) return res.status(400).json({ error: 'Key is required.' });
      this.db.deleteContext(targetRoom, key);
      res.json({ success: true });
    });

    // 10. Global Context History
    this.app.get('/api/context/history', (req: Request, res: Response) => {
      const roomCode = ((req.query.roomCode as string) || this.roomCode).toUpperCase();
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const history = this.db.getContextHistory(roomCode, limit);
      res.json({ history });
    });

    // 11. Agent Heartbeat / Status
    this.app.post('/api/agents/heartbeat', (req: Request, res: Response) => {
      const { roomCode, name, status, currentTask } = req.body;
      const targetRoom = (roomCode || this.roomCode).toUpperCase();

      if (!name) return res.status(400).json({ error: 'Agent name is required.' });

      this.db.updateAgentHeartbeat(targetRoom, name, status, currentTask);
      if (status || currentTask !== undefined) {
        this.broadcastToRoom(targetRoom, {
          type: 'agent_status',
          name: this.db.normalizeName(name),
          status: status || 'idle',
          currentTask,
        });
      }

      res.json({ success: true });
    });

    // 12. Server-Sent Events (SSE) Stream
    this.app.get('/api/stream', (req: Request, res: Response) => {
      const roomCode = ((req.query.roomCode as string) || this.roomCode).toUpperCase();
      const rawName = (req.query.name as string) || 'observer';
      const agentName = this.db.normalizeName(rawName);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const clientId = `${roomCode}:${agentName}:${Date.now()}`;
      this.sseClients.set(clientId, { res, roomCode, agentName });

      // Send initial hello
      res.write(`data: ${JSON.stringify({ type: 'connected', roomCode, agentName })}\n\n`);

      req.on('close', () => {
        this.sseClients.delete(clientId);
      });
    });

    // Catch-all route to serve SPA
    this.app.use((req: Request, res: Response, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(path.resolve(publicPath, 'index.html'));
    });
  }

  private setupWebSockets() {
    this.wss.on('connection', (ws: WebSocket) => {
      const client: SocketClient = { ws, isAlive: true };
      this.clients.add(client);

      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('message', (raw: string) => {
        try {
          const payload = JSON.parse(raw.toString()) as WSClientMessage;
          this.handleClientMessage(client, payload);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON message' }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(client);
        if (client.roomCode && client.agentName) {
          this.broadcastToRoom(client.roomCode, {
            type: 'agent_status',
            name: client.agentName,
            status: 'offline',
          });
        }
      });
    });
  }

  private handleClientMessage(client: SocketClient, payload: WSClientMessage) {
    if (payload.type === 'ping') {
      client.ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (payload.type === 'join') {
      const targetRoom = (payload.roomCode || this.roomCode).toUpperCase();
      if (targetRoom !== this.roomCode) {
        client.ws.send(JSON.stringify({ type: 'error', error: `Room ${targetRoom} not found.` }));
        return;
      }

      const agent = this.db.upsertAgent(
        targetRoom,
        payload.name,
        payload.agentType || 'custom',
        payload.status || 'idle'
      );

      client.roomCode = targetRoom;
      client.agentName = agent.name;
      client.agentType = agent.agentType;

      const room = this.db.getRoom(targetRoom) || {
        code: targetRoom,
        hostName: this.hostName,
        createdAt: Date.now(),
      };
      const allAgents = this.db.getAgents(targetRoom);
      const context = this.db.getAllContext(targetRoom);
      const recentMessages = this.db.getMessages(targetRoom, { forAgent: agent.name, limit: 50 });

      // Welcome response to this client
      const welcome: WSServerMessage = {
        type: 'welcome',
        agent,
        room,
        agents: allAgents,
        context,
        recentMessages,
      };
      client.ws.send(JSON.stringify(welcome));

      // Notify others in room
      this.broadcastToRoom(targetRoom, { type: 'agent_joined', agent }, client);
      return;
    }

    if (!client.roomCode || !client.agentName) {
      client.ws.send(JSON.stringify({ type: 'error', error: 'Must send join message first.' }));
      return;
    }

    if (payload.type === 'message') {
      const msg = this.db.saveMessage(
        client.roomCode,
        client.agentName,
        client.agentType || 'custom',
        payload.to || '@all',
        payload.content,
        payload.tags || []
      );
      this.dispatchMessage(msg);
      return;
    }

    if (payload.type === 'status') {
      this.db.updateAgentHeartbeat(client.roomCode, client.agentName, payload.status, payload.currentTask);
      this.broadcastToRoom(client.roomCode, {
        type: 'agent_status',
        name: client.agentName,
        status: payload.status,
        currentTask: payload.currentTask,
      });
      return;
    }

    if (payload.type === 'context_set') {
      const item = this.db.setContext(
        client.roomCode,
        payload.key,
        payload.section || 'general',
        payload.content,
        client.agentName
      );
      this.broadcastToRoom(client.roomCode, {
        type: 'context_updated',
        item,
        updatedBy: client.agentName,
      });
      return;
    }

    if (payload.type === 'context_append') {
      const item = this.db.appendContext(
        client.roomCode,
        payload.key,
        payload.section || 'general',
        payload.entry,
        client.agentName
      );
      this.broadcastToRoom(client.roomCode, {
        type: 'context_updated',
        item,
        updatedBy: client.agentName,
      });
      return;
    }
  }

  private dispatchMessage(message: Message) {
    // 1. WebSocket delivery
    for (const client of this.clients) {
      if (client.roomCode !== message.roomCode) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Delivery rule:
      // If broadcast (@all): deliver to everyone
      // If private: deliver to sender, recipient, or human observers
      const isObserver = client.agentType === 'human' || client.agentName === '@human';
      const isSender = client.agentName === message.senderName;
      const isRecipient = client.agentName === message.recipientName;

      if (!message.isPrivate || isObserver || isSender || isRecipient) {
        try {
          client.ws.send(JSON.stringify({ type: 'message', message }));
        } catch {
          // Socket might have closed concurrently
        }
      }
    }

    // 2. SSE delivery
    const sseData = `data: ${JSON.stringify({ type: 'message', message })}\n\n`;
    for (const [id, sseClient] of this.sseClients) {
      if (sseClient.roomCode !== message.roomCode) continue;

      const isObserver = sseClient.agentName === '@human' || sseClient.agentName === '@observer';
      const isSender = sseClient.agentName === message.senderName;
      const isRecipient = sseClient.agentName === message.recipientName;

      if (!message.isPrivate || isObserver || isSender || isRecipient) {
        try {
          sseClient.res.write(sseData);
        } catch {
          this.sseClients.delete(id);
        }
      }
    }
  }

  private broadcastToRoom(roomCode: string, payload: WSServerMessage, exceptClient?: SocketClient) {
    const data = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client === exceptClient) continue;
      if (client.roomCode !== roomCode) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch {
          // Socket closed concurrently
        }
      }
    }

    // Also push to SSE clients
    const sseData = `data: ${data}\n\n`;
    for (const [id, sseClient] of this.sseClients) {
      if (sseClient.roomCode === roomCode) {
        try {
          sseClient.res.write(sseData);
        } catch {
          this.sseClients.delete(id);
        }
      }
    }
  }

  private heartbeatTimer?: NodeJS.Timeout;

  private setupHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.isAlive = false;
        try {
          client.ws.ping();
        } catch {
          // Socket closed
        }
      }
    }, 30000);
    this.heartbeatTimer.unref();
  }

  public async start(): Promise<{ localUrl: string; lanUrls: string[]; tunnelUrl?: string }> {
    // Register initial room in database
    this.db.createRoom(this.roomCode, this.hostName, this.publicUrl);

    // Initial default shared context items
    this.db.setContext(
      this.roomCode,
      'welcome_manifest',
      'overview',
      `Welcome to Aexting Swarm Network (Agent Texting)!\nRoom Code: ${this.roomCode}\nGlobal Context is shared across all agents in real time.`,
      '@system'
    );

    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, async () => {
        const lanIps = getLanIps();
        const localUrl = `http://localhost:${this.port}`;
        const lanUrls = lanIps.map((ip) => `http://${ip}:${this.port}`);

        let tunnelUrl = this.publicUrl;

        if ((this.enableTunnel || this.tunnelToken) && !tunnelUrl) {
          console.log(pc.cyan('⚡ Starting Cloudflare Tunnel for remote machines...'));
          const tunnelResult = await createPublicTunnel({
            port: this.port,
            tunnelToken: this.tunnelToken,
            publicUrl: this.publicUrl,
          });
          if (tunnelResult) {
            tunnelUrl = tunnelResult.url;
            this.publicUrl = tunnelUrl;
            this.tunnelClose = tunnelResult.close;
            this.db.updateRoomTunnel(this.roomCode, tunnelUrl);
          }
        }

        resolve({ localUrl, lanUrls, tunnelUrl });
      });
    });
  }

  public async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.tunnelClose) {
      await this.tunnelClose();
    }
    this.wss.close();
    this.server.close();
  }
}

export const NexusServer = AextingServer;

// Auto-start if invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = new AextingServer({
    port: parseInt(process.env.PORT || '7331', 10),
    roomCode: process.env.AEXTING_ROOM || process.env.NEXUS_ROOM,
    enableTunnel: process.env.AEXTING_TUNNEL === 'true' || process.env.NEXUS_TUNNEL === 'true',
    tunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
  });
  server.start().then((info) => {
    console.log(pc.bold(pc.green(`⚡ Aexting Swarm Host running at ${info.localUrl} [Room: ${server.roomCode}]`)));
  });
}

