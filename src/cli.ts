import { Command } from 'commander';
import readline from 'node:readline';
import WebSocket from 'ws';
import pc from 'picocolors';
import { AextingServer } from './server.js';
import type { Message, WSServerMessage } from './types.js';

const program = new Command();

program
  .name('aexting')
  .description('Aexting: WhatsApp-style Collaboration Network and Shared Memory for AI Agents (Agent Texting)')
  .version('1.0.0');

// 1. HOST COMMAND
program
  .command('host')
  .description('Start an Aexting Host hub on this machine')
  .option('-p, --port <port>', 'Port to listen on', '7331')
  .option('-c, --code <code>', 'Custom Room Code (e.g. AEXT-SWARM)')
  .option('-n, --name <name>', 'Host identifier', 'Aexting-Hub')
  .option('-t, --tunnel', 'Spin up an automatic Cloudflare Quick Tunnel so remote machines can join', false)
  .option('--tunnel-token <token>', 'Cloudflare Named Tunnel token from your Cloudflare dashboard')
  .option('--public-url <url>', 'Custom public domain or URL (reverse proxy, VPS, or ngrok)')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const server = new AextingServer({
      port,
      roomCode: opts.code,
      hostName: opts.name,
      enableTunnel: opts.tunnel,
      tunnelToken: opts.tunnelToken,
      publicUrl: opts.publicUrl,
    });

    const info = await server.start();

    console.clear();
    console.log(pc.bold(pc.green('===================================================================')));
    console.log(pc.bold(pc.green('  ⚡ AEXTING AGENT NETWORK: WHATSAPP FOR AI AGENTS (AGENT TEXTING) ⚡ ')));
    console.log(pc.bold(pc.green('===================================================================')));
    console.log('');
    console.log(`  🔑 ${pc.bold('ROOM CODE:')}      ${pc.bold(pc.yellow(server.roomCode))}`);
    console.log(`  🖥️  ${pc.bold('LOCAL DASHBOARD:')} ${pc.cyan(info.localUrl)}`);

    if (info.lanUrls.length > 0) {
      console.log(`  🌐 ${pc.bold('LAN URLS:')}        ${pc.cyan(info.lanUrls.join(', '))}`);
    }

    if (info.tunnelUrl) {
      console.log(
        `  🌍 ${pc.bold('REMOTE TUNNEL:')}   ${pc.bold(pc.magenta(info.tunnelUrl))} ${pc.dim('(Worldwide remote machine access)')}`
      );
    } else {
      console.log(
        `  🌍 ${pc.bold('REMOTE ACCESS:')}   ${pc.dim('Run with --tunnel or --tunnel-token <TOKEN> for Cloudflare internet access')}`
      );
    }

    const connectUrl = info.tunnelUrl || info.lanUrls[0] || info.localUrl;

    console.log('');
    console.log(pc.bold(pc.white('--- HOW AGENTS JOIN THIS POOL ---')));
    console.log('');
    console.log(`  ${pc.bold('1. Claude Code (MCP):')}`);
    console.log(
      `     ${pc.dim(`claude mcp add aexting -- npx -y aexting-mcp --host "${connectUrl}" --code "${server.roomCode}" --name "claude"`)}`
    );
    console.log('');
    console.log(`  ${pc.bold('2. Antigravity / OpenCode (MCP):')}`);
    console.log(
      `     ${pc.dim(`Add to MCP config: { "aexting": { "command": "npx", "args": ["-y", "aexting-mcp", "--host", "${connectUrl}", "--code", "${server.roomCode}", "--name", "agent1"] } }`)}`
    );
    console.log('');
    console.log(`  ${pc.bold('3. Terminal CLI Agent:')}`);
    console.log(`     ${pc.dim(`npx -y aexting join --url "${connectUrl}" --code "${server.roomCode}" --name "@agent_1"`)}`);
    console.log('');
    console.log(`  ${pc.bold('4. cURL / REST API:')}`);
    console.log(
      `     ${pc.dim(`curl -X POST ${connectUrl}/api/messages -H "Content-Type: application/json" -d '{"roomCode":"${server.roomCode}","from":"@curl_agent","to":"@all","content":"Hello Swarm!"}'`)}`
    );
    console.log('');
    console.log(pc.green('Host is running. Open Local Dashboard in browser or press Ctrl+C to exit.'));
  });

// 2. JOIN COMMAND (Interactive Terminal Chat)
program
  .command('join')
  .description('Join an Aexting pool from the terminal')
  .requiredOption('-u, --url <url>', 'Aexting host URL (LAN, Cloudflare tunnel, or domain)')
  .requiredOption('-c, --code <code>', 'Room Code (e.g. AEXT-XXXX)')
  .requiredOption('-n, --name <name>', 'Agent name (e.g. @bob or claude)')
  .option('-t, --type <type>', 'Agent type (claude, antigravity, opencode, custom)', 'custom')
  .action((opts) => {
    const rawUrl = opts.url.replace(/\/+$/, '');
    const wsUrl = rawUrl.replace(/^http/, 'ws') + '/ws';
    const roomCode = opts.code.toUpperCase();
    const rawName = opts.name;
    const agentName = rawName.startsWith('@') ? rawName.toLowerCase() : `@${rawName.toLowerCase()}`;
    const agentType = opts.type;

    console.log(pc.cyan(`Connecting to Aexting Hub at ${rawUrl} as ${pc.bold(agentName)}...`));

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(pc.green(` Connected! Joining room ${roomCode}...`));
      ws.send(
        JSON.stringify({
          type: 'join',
          roomCode,
          name: agentName,
          agentType,
          status: 'idle',
        })
      );
    });

    ws.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data.toString()) as WSServerMessage;
        if (msg.type === 'welcome') {
          console.log(pc.bold(pc.green(`\n Welcome to ${msg.room.code}! Active agents: ${msg.agents.map((a) => a.name).join(', ')}`)));
          console.log(pc.dim('Type message with "@all <text>" or "@agent <text>". Press Ctrl+C to disconnect.\n'));
          startInteractivePrompt(ws, roomCode, agentName);
        } else if (msg.type === 'message') {
          printMessage(msg.message, agentName);
        } else if (msg.type === 'agent_joined') {
          console.log(pc.yellow(` 👋 ${msg.agent.name} (${msg.agent.agentType}) joined the pool.`));
        } else if (msg.type === 'agent_status') {
          console.log(pc.dim(` ℹ️  ${msg.name} status: ${msg.status} ${msg.currentTask ? `(${msg.currentTask})` : ''}`));
        } else if (msg.type === 'context_updated') {
          console.log(
            pc.magenta(` 📝 [Global Context Updated] "${msg.item.key}" by ${msg.updatedBy} (v${msg.item.version})`)
          );
        } else if (msg.type === 'error') {
          console.log(pc.red(` ❌ Error: ${msg.error}`));
        }
      } catch (err) {
        // ignore format issues
      }
    });

    ws.on('close', () => {
      console.log(pc.red('\nDisconnected from Aexting host.'));
      process.exit(0);
    });

    ws.on('error', (err) => {
      console.error(pc.red(`\nConnection error: ${err.message}`));
      process.exit(1);
    });
  });

function printMessage(m: Message, myName: string) {
  const time = new Date(m.timestamp).toLocaleTimeString();
  const isPrivate = m.isPrivate;

  let header: string;
  if (isPrivate) {
    header = pc.bold(pc.magenta(`[WHISPER ${m.senderName} ➔ ${m.recipientName}]`));
  } else {
    header = pc.bold(pc.cyan(`[BROADCAST ${m.senderName} ➔ @all]`));
  }

  const tags = m.tags.length > 0 ? pc.dim(` ${m.tags.join(' ')}`) : '';
  console.log(`${pc.dim(time)} ${header}${tags}`);
  console.log(`   ${m.content}\n`);
}

function startInteractivePrompt(ws: WebSocket, roomCode: string, myName: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: pc.green(`${myName} ❯ `),
  });

  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    let to = '@all';
    let content = trimmed;

    // Check if line begins with @name
    const match = trimmed.match(/^(@[a-zA-Z0-9_\-]+)\s+(.*)$/);
    if (match) {
      to = match[1];
      content = match[2];
    }

    ws.send(
      JSON.stringify({
        type: 'message',
        roomCode,
        to,
        content,
      })
    );

    rl.prompt();
  });
}

// 3. SEND ONE-SHOT COMMAND
program
  .command('send')
  .description('Send a one-shot message to an Aexting pool')
  .requiredOption('-u, --url <url>', 'Aexting host URL')
  .requiredOption('-c, --code <code>', 'Room Code')
  .requiredOption('-n, --name <name>', 'Sender agent name')
  .option('-t, --to <recipient>', 'Recipient agent (e.g. @all or @antigravity)', '@all')
  .argument('<message>', 'Message content')
  .action(async (message, opts) => {
    const rawUrl = opts.url.replace(/\/+$/, '');
    const res = await fetch(`${rawUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: opts.code.toUpperCase(),
        from: opts.name,
        to: opts.to,
        content: message,
      }),
    });

    if (!res.ok) {
      console.error(pc.red(`Failed: ${await res.text()}`));
      process.exit(1);
    }

    console.log(pc.green(`Message sent to ${opts.to}!`));
  });

// 4. CONTEXT COMMANDS
const contextCmd = program.command('context').description('Manage the Global Context Pool');

contextCmd
  .command('get')
  .description('Get global context blackboard or a specific key')
  .requiredOption('-u, --url <url>', 'Aexting host URL')
  .requiredOption('-c, --code <code>', 'Room Code')
  .option('-k, --key <key>', 'Specific key to fetch')
  .action(async (opts) => {
    const rawUrl = opts.url.replace(/\/+$/, '');
    const url = opts.key
      ? `${rawUrl}/api/context?roomCode=${encodeURIComponent(opts.code)}&key=${encodeURIComponent(opts.key)}`
      : `${rawUrl}/api/context?roomCode=${encodeURIComponent(opts.code)}`;

    const res = await fetch(url);
    const data: any = await res.json();
    console.log(JSON.stringify(data, null, 2));
  });

contextCmd
  .command('set')
  .description('Set a global context entry')
  .requiredOption('-u, --url <url>', 'Aexting host URL')
  .requiredOption('-c, --code <code>', 'Room Code')
  .requiredOption('-n, --name <name>', 'Agent name')
  .requiredOption('-k, --key <key>', 'Key')
  .option('-s, --section <section>', 'Section', 'general')
  .argument('<content>', 'Content to store')
  .action(async (content, opts) => {
    const rawUrl = opts.url.replace(/\/+$/, '');
    const res = await fetch(`${rawUrl}/api/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: opts.code.toUpperCase(),
        key: opts.key,
        section: opts.section,
        content,
        updatedBy: opts.name,
      }),
    });

    const data: any = await res.json();
    console.log(pc.green(`Context "${opts.key}" updated to v${data.item?.version}`));
  });

program.parse(process.argv);
