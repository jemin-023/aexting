export type AgentType = 'claude' | 'antigravity' | 'opencode' | 'aider' | 'custom' | 'human';

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'offline';

export interface Room {
  code: string;
  hostName: string;
  createdAt: number;
  tunnelUrl?: string;
  lanUrl?: string;
}

export interface Agent {
  name: string; // e.g. '@claude', '@antigravity', '@architect'
  roomCode: string;
  agentType: AgentType;
  status: AgentStatus;
  currentTask?: string;
  joinedAt: number;
  lastSeen: number;
}

export interface Message {
  id: string;
  roomCode: string;
  senderName: string;
  senderType: AgentType;
  recipientName: string; // '@all' for broadcast, or '@agent' for private DM
  content: string;
  tags: string[];
  isPrivate: boolean;
  timestamp: number;
}

export interface ContextItem {
  key: string;
  roomCode: string;
  section: string; // e.g. 'architecture', 'decisions', 'tasks', 'specs', 'scratchpad'
  content: string;
  updatedBy: string;
  updatedAt: number;
  version: number;
}

export interface ContextHistory {
  id: string;
  roomCode: string;
  key: string;
  section: string;
  oldContent: string;
  newContent: string;
  updatedBy: string;
  timestamp: number;
}

// WebSocket Protocol Messages
export type WSClientMessage =
  | { type: 'join'; roomCode: string; name: string; agentType: AgentType; status?: AgentStatus }
  | { type: 'message'; roomCode: string; to: string; content: string; tags?: string[] }
  | { type: 'status'; roomCode: string; status: AgentStatus; currentTask?: string }
  | { type: 'context_set'; roomCode: string; key: string; section?: string; content: string }
  | { type: 'context_append'; roomCode: string; key: string; section?: string; entry: string }
  | { type: 'ping' };

export type WSServerMessage =
  | { type: 'welcome'; agent: Agent; room: Room; agents: Agent[]; context: ContextItem[]; recentMessages: Message[] }
  | { type: 'message'; message: Message }
  | { type: 'agent_joined'; agent: Agent }
  | { type: 'agent_left'; name: string }
  | { type: 'agent_status'; name: string; status: AgentStatus; currentTask?: string }
  | { type: 'context_updated'; item: ContextItem; updatedBy: string }
  | { type: 'error'; error: string }
  | { type: 'pong' };
