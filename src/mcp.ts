import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { program } from 'commander';

program
  .option(
    '-h, --host <url>',
    'Aexting host URL (LAN or Public Tunnel)',
    process.env.AEXTING_HOST || process.env.NEXUS_HOST || 'http://localhost:7331'
  )
  .option('-c, --code <code>', 'Aexting Room Code', process.env.AEXTING_ROOM || process.env.NEXUS_ROOM || 'AEXT-MAIN')
  .option(
    '-n, --name <name>',
    'Agent name (e.g. @claude, @antigravity, @opencode)',
    process.env.AEXTING_AGENT_NAME || process.env.NEXUS_AGENT_NAME || '@agent'
  )
  .option(
    '-t, --type <type>',
    'Agent type (claude, antigravity, opencode, custom)',
    process.env.AEXTING_AGENT_TYPE || process.env.NEXUS_AGENT_TYPE || 'custom'
  )
  .parse(process.argv);

const options = program.opts();
const hostUrl = options.host.replace(/\/+$/, '');
const roomCode = options.code.toUpperCase();
const rawName = options.name;
const agentName = rawName.startsWith('@') ? rawName.toLowerCase() : `@${rawName.toLowerCase()}`;
const agentType = options.type;

async function apiRequest<T>(endpoint: string, method: string = 'GET', body?: any): Promise<T> {
  const url = `${hostUrl}${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Aexting API error [${res.status}]: ${errorText}`);
  }

  return res.json() as Promise<T>;
}

async function startMcpServer() {
  // 1. Join room
  try {
    await apiRequest('/api/pool/join', 'POST', {
      roomCode,
      name: agentName,
      agentType,
      status: 'idle',
    });
  } catch (err: any) {
    console.error(`[Aexting-MCP] Failed to connect to Aexting Host at ${hostUrl}:`, err.message);
  }

  // Heartbeat every 20s
  const heartbeat = setInterval(async () => {
    try {
      await apiRequest('/api/agents/heartbeat', 'POST', {
        roomCode,
        name: agentName,
      });
    } catch {
      // ignore transient network hiccups
    }
  }, 20000);
  heartbeat.unref();

  const server = new McpServer({
    name: `aexting-swarm-${agentName}`,
    version: '1.0.0',
  });

  // Tool Handlers
  const sendMessageHandler = async ({ to, message, tags }: { to: string; message: string; tags?: string[] }) => {
    try {
      const result: any = await apiRequest('/api/messages', 'POST', {
        roomCode,
        from: agentName,
        to,
        content: message,
        tags: tags || [],
        agentType,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Message sent successfully to ${to} (ID: ${result.message.id}, timestamp: ${new Date(result.message.timestamp).toLocaleTimeString()})`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to send message: ${err.message}` }],
        isError: true,
      };
    }
  };

  const readMessagesHandler = async ({ since_minutes_ago, limit }: { since_minutes_ago?: number; limit?: number }) => {
    try {
      const sinceTimestamp = Date.now() - (since_minutes_ago || 30) * 60 * 1000;
      const result: any = await apiRequest(
        `/api/messages?roomCode=${encodeURIComponent(roomCode)}&forAgent=${encodeURIComponent(agentName)}&since=${sinceTimestamp}&limit=${limit || 20}`
      );

      const msgs = result.messages || [];
      if (msgs.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No new messages in Aexting pool.' }] };
      }

      const formatted = msgs
        .map((m: any) => {
          const time = new Date(m.timestamp).toLocaleTimeString();
          const prefix = m.isPrivate ? `[PRIVATE WHISPER from ${m.senderName}]` : `[BROADCAST from ${m.senderName}]`;
          return `${time} ${prefix}: ${m.content}`;
        })
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to read messages: ${err.message}` }],
        isError: true,
      };
    }
  };

  const getContextHandler = async ({ key }: { key?: string }) => {
    try {
      if (key) {
        const result: any = await apiRequest(
          `/api/context?roomCode=${encodeURIComponent(roomCode)}&key=${encodeURIComponent(key)}`
        );
        const item = result.item;
        return {
          content: [
            {
              type: 'text' as const,
              text: `[Key: ${item.key}] (Section: ${item.section}, Updated by ${item.updatedBy} v${item.version} at ${new Date(item.updatedAt).toLocaleTimeString()}):\n${item.content}`,
            },
          ],
        };
      }

      const result: any = await apiRequest(`/api/context?roomCode=${encodeURIComponent(roomCode)}`);
      const items = result.context || [];

      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Global context pool is currently empty.' }] };
      }

      const formatted = items
        .map(
          (i: any) =>
            `=== [${i.section.toUpperCase()}] ${i.key} (v${i.version} by ${i.updatedBy}) ===\n${i.content}`
        )
        .join('\n\n-----------------------------\n\n');

      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get global context: ${err.message}` }],
        isError: true,
      };
    }
  };

  const setContextHandler = async ({ key, content, section }: { key: string; content: string; section?: string }) => {
    try {
      const result: any = await apiRequest('/api/context', 'POST', {
        roomCode,
        key,
        section: section || 'general',
        content,
        updatedBy: agentName,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Global context updated: "${key}" (v${result.item.version}) under section [${result.item.section}]. All agents in the pool have been notified.`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to set global context: ${err.message}` }],
        isError: true,
      };
    }
  };

  const appendContextHandler = async ({ key, entry, section }: { key: string; entry: string; section?: string }) => {
    try {
      const formattedEntry = `[${new Date().toLocaleTimeString()} by ${agentName}]: ${entry}`;
      const result: any = await apiRequest('/api/context/append', 'POST', {
        roomCode,
        key,
        section: section || 'general',
        entry: formattedEntry,
        updatedBy: agentName,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Appended to global context "${key}" (v${result.item.version}).`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to append to global context: ${err.message}` }],
        isError: true,
      };
    }
  };

  const listAgentsHandler = async () => {
    try {
      const result: any = await apiRequest(`/api/pool/agents?roomCode=${encodeURIComponent(roomCode)}`);
      const agents = result.agents || [];

      if (agents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No agents registered in pool.' }] };
      }

      const formatted = agents
        .map((a: any) => {
          const isOnline = Date.now() - a.lastSeen < 60000;
          const statusIcon = isOnline ? '🟢 Online' : '⚪ Offline';
          const taskStr = a.currentTask ? ` - Working on: "${a.currentTask}"` : '';
          return `${statusIcon} ${a.name} (${a.agentType}) [${a.status}]${taskStr}`;
        })
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Agents in room ${roomCode}:\n${formatted}` }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list agents: ${err.message}` }],
        isError: true,
      };
    }
  };

  const updateStatusHandler = async ({ status, current_task }: { status: 'idle' | 'working' | 'waiting'; current_task?: string }) => {
    try {
      await apiRequest('/api/agents/heartbeat', 'POST', {
        roomCode,
        name: agentName,
        status,
        currentTask: current_task,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Status updated to "${status}"${current_task ? ` (${current_task})` : ''}.`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to update status: ${err.message}` }],
        isError: true,
      };
    }
  };

  // Register tools under aexting_* and aliases under nexus_*
  const toolDefs = [
    {
      names: ['aexting_send_message', 'nexus_send_message'],
      description: 'Send a message to another agent or broadcast to everyone in the pool. Use to="@all" for broadcast, or to="@agent_name" for a private whisper.',
      schema: {
        to: z.string().describe('Recipient agent name (e.g. "@all", "@antigravity", "@claude", "@opencode")'),
        message: z.string().describe('Content of the message to send'),
        tags: z.array(z.string()).optional().describe('Optional tags, e.g. ["#bug", "#decision", "#task"]'),
      },
      handler: sendMessageHandler,
    },
    {
      names: ['aexting_read_messages', 'nexus_read_messages'],
      description: 'Read messages from the pool inbox. Returns broadcast messages (@all) and private whispers addressed specifically to you.',
      schema: {
        since_minutes_ago: z.number().optional().default(30).describe('Only fetch messages newer than X minutes ago'),
        limit: z.number().optional().default(20).describe('Max number of messages to fetch'),
      },
      handler: readMessagesHandler,
    },
    {
      names: ['aexting_get_global_context', 'nexus_get_global_context'],
      description: 'Retrieve items from the global context blackboard shared across all agents in the pool.',
      schema: {
        key: z.string().optional().describe('Specific context key to inspect, e.g. "architecture", "task_list", "api_spec"'),
      },
      handler: getContextHandler,
    },
    {
      names: ['aexting_set_global_context', 'nexus_set_global_context'],
      description: 'Store or overwrite an entry in the global context pool. Used to note down things that you want all other agents to remember.',
      schema: {
        key: z.string().describe('Unique identifier for this context entry'),
        content: z.string().describe('The content or notes to record in the shared pool'),
        section: z.string().optional().default('general').describe('Section category'),
      },
      handler: setContextHandler,
    },
    {
      names: ['aexting_append_global_context', 'nexus_append_global_context'],
      description: 'Append a line or note to an existing key in the global context pool without wiping out existing content.',
      schema: {
        key: z.string().describe('Key to append to (e.g. "task_log", "todo_list")'),
        entry: z.string().describe('New line or entry to append'),
        section: z.string().optional().default('general').describe('Section category'),
      },
      handler: appendContextHandler,
    },
    {
      names: ['aexting_list_agents', 'nexus_list_agents'],
      description: 'List all agents currently in the pool along with their status, runtime type, and current task.',
      schema: {},
      handler: listAgentsHandler,
    },
    {
      names: ['aexting_update_status', 'nexus_update_status'],
      description: 'Update your current activity status and task description so other agents and human observers know what you are doing.',
      schema: {
        status: z.enum(['idle', 'working', 'waiting']).describe('Current agent state'),
        current_task: z.string().optional().describe('Short summary of what you are working on'),
      },
      handler: updateStatusHandler,
    },
  ];

  for (const def of toolDefs) {
    for (const name of def.names) {
      server.tool(name, def.description, def.schema as any, def.handler as any);
    }
  }

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startMcpServer().catch((err) => {
  console.error('[Aexting-MCP] Fatal error:', err);
  process.exit(1);
});
