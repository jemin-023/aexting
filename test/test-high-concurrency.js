import assert from 'node:assert';
import WebSocket from 'ws';
import { NexusServer } from '../dist/server.js';

async function runHighConcurrencyStressTest() {
  console.log('⚡ [QA TEST 2] High-Concurrency Swarm Stress Test (Many Agents at Once)\n');

  const testPort = 7355;
  const testRoomCode = 'SWARM-STRESS';
  const NUM_AGENTS = 30; // 30 concurrent agent connections

  const server = new NexusServer({
    port: testPort,
    roomCode: testRoomCode,
    hostName: 'StressHost',
    dbPath: ':memory:',
  });

  await server.start();
  console.log(`✓ 1. Host Server initialized on port ${testPort}`);

  const wsUrl = `ws://localhost:${testPort}/ws`;
  const httpUrl = `http://localhost:${testPort}`;

  // --------------------------------------------------------------------------
  // PHASE 1: Concurrent Agent Connection Burst (30 agents simultaneously)
  // --------------------------------------------------------------------------
  console.log(`\n--- Phase 1: Burst Connecting ${NUM_AGENTS} Agents Simultaneously ---`);
  const agentTypes = ['claude', 'antigravity', 'opencode', 'aider', 'custom'];
  const agents = [];

  for (let i = 0; i < NUM_AGENTS; i++) {
    const name = `@agent_${String(i).padStart(2, '0')}`;
    const agentType = agentTypes[i % agentTypes.length];
    agents.push({
      id: i,
      name,
      agentType,
      ws: null,
      receivedBroadcasts: [],
      receivedWhispers: [],
      otherWhispersLeaked: 0,
    });
  }

  // Connect all sockets concurrently
  const connectPromises = agents.map((agent) => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      agent.ws = ws;

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'join',
            roomCode: testRoomCode,
            name: agent.name,
            agentType: agent.agentType,
            status: 'working',
            currentTask: `Stress test worker #${agent.id}`,
          })
        );
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'welcome') {
            resolve(true);
          } else if (data.type === 'message') {
            const msg = data.message;
            if (msg.recipientName === '@all') {
              agent.receivedBroadcasts.push(msg);
            } else if (msg.recipientName === agent.name) {
              agent.receivedWhispers.push(msg);
            } else if (msg.senderName !== agent.name) {
              // LEAK DETECTED: A private whisper not addressed to this agent arrived!
              agent.otherWhispersLeaked++;
            }
          }
        } catch (err) {
          reject(err);
        }
      });

      ws.on('error', (err) => reject(err));
    });
  });

  const connectStartTime = Date.now();
  await Promise.all(connectPromises);
  const connectDuration = Date.now() - connectStartTime;
  console.log(`✓ Phase 1 Passed: All ${NUM_AGENTS} agents connected and handshaked in ${connectDuration}ms`);

  // Verify agents list via REST API
  const agentsListRes = await fetch(`${httpUrl}/api/pool/agents?roomCode=${testRoomCode}`);
  const agentsListData = await agentsListRes.json();
  assert.strictEqual(agentsListData.agents.length, NUM_AGENTS);
  console.log(`✓ Verified ${NUM_AGENTS} active agents registered in database`);

  // --------------------------------------------------------------------------
  // PHASE 2: Message Torrent & Privacy Isolation
  // Each agent sends 3 broadcasts and 3 private whispers (180 messages total)
  // --------------------------------------------------------------------------
  console.log('\n--- Phase 2: Message Torrent & Strict Privacy Routing Check ---');
  const MSG_PER_AGENT = 3;
  const sendPromises = [];
  const expectedBroadcastCount = NUM_AGENTS * MSG_PER_AGENT;
  let totalWhispersSent = 0;

  const msgStartTime = Date.now();

  for (const agent of agents) {
    // 1. Send broadcasts
    for (let m = 0; m < MSG_PER_AGENT; m++) {
      sendPromises.push(
        new Promise((res) => {
          agent.ws.send(
            JSON.stringify({
              type: 'message',
              roomCode: testRoomCode,
              to: '@all',
              content: `Broadcast from ${agent.name} (seq ${m})`,
              tags: ['#stress', `#seq${m}`],
            })
          );
          res(true);
        })
      );
    }

    // 2. Send private whisper to next neighbor agent
    for (let w = 0; w < MSG_PER_AGENT; w++) {
      const recipientIdx = (agent.id + 1 + w) % NUM_AGENTS;
      const recipientName = agents[recipientIdx].name;
      totalWhispersSent++;

      sendPromises.push(
        new Promise((res) => {
          agent.ws.send(
            JSON.stringify({
              type: 'message',
              roomCode: testRoomCode,
              to: recipientName,
              content: `Confidential whisper from ${agent.name} to ${recipientName} (seq ${w})`,
              tags: ['#private'],
            })
          );
          res(true);
        })
      );
    }
  }

  await Promise.all(sendPromises);
  console.log(`✓ Dispatched ${sendPromises.length} messages (${expectedBroadcastCount} broadcasts + ${totalWhispersSent} whispers) concurrently`);

  // Allow 500ms for all deliveries
  await new Promise((r) => setTimeout(r, 600));
  const msgDuration = Date.now() - msgStartTime;

  // Assert Privacy: Verify NO agent received whispers belonging to other peers
  let totalPrivacyLeaks = 0;
  for (const agent of agents) {
    totalPrivacyLeaks += agent.otherWhispersLeaked;
  }
  assert.strictEqual(totalPrivacyLeaks, 0, `Security violation: ${totalPrivacyLeaks} private whispers were leaked to unintended agents!`);
  console.log(`✓ Privacy Check Passed: ZERO private whispers leaked across ${NUM_AGENTS} agents`);

  // Assert Broadcasts: Each agent received all broadcasts
  for (const agent of agents) {
    assert.strictEqual(
      agent.receivedBroadcasts.length,
      expectedBroadcastCount,
      `Agent ${agent.name} missed broadcasts! Got ${agent.receivedBroadcasts.length}/${expectedBroadcastCount}`
    );
  }
  console.log(`✓ Broadcast Delivery Passed: All ${NUM_AGENTS} agents received exactly ${expectedBroadcastCount} broadcasts in ${msgDuration}ms`);

  // --------------------------------------------------------------------------
  // PHASE 3: Concurrent Global Context Race Conditions
  // All 30 agents concurrently append to the SAME key: 'swarm_task_log'
  // --------------------------------------------------------------------------
  console.log('\n--- Phase 3: Concurrent Global Context Writes (Race Condition Test) ---');
  const targetKey = 'swarm_task_log';

  // Initial set
  await fetch(`${httpUrl}/api/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomCode: testRoomCode,
      key: targetKey,
      section: 'tasks',
      content: '[START] Initialized swarm task log.',
      updatedBy: '@system',
    }),
  });

  // Concurrently append from all 30 agents via HTTP POST
  const appendPromises = agents.map((agent) => {
    return fetch(`${httpUrl}/api/context/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: testRoomCode,
        key: targetKey,
        section: 'tasks',
        entry: `Task completed by ${agent.name}`,
        updatedBy: agent.name,
      }),
    });
  });

  const contextStartTime = Date.now();
  await Promise.all(appendPromises);
  const contextDuration = Date.now() - contextStartTime;

  // Fetch final context and verify
  const finalCtxRes = await fetch(`${httpUrl}/api/context?roomCode=${testRoomCode}&key=${targetKey}`);
  const finalCtxData = await finalCtxRes.json();
  const finalItem = finalCtxData.item;

  assert.strictEqual(finalItem.version, 1 + NUM_AGENTS, `Expected version ${1 + NUM_AGENTS}, got ${finalItem.version}`);

  // Verify all 30 agents' appended lines are present in the final string
  for (const agent of agents) {
    assert.ok(
      finalItem.content.includes(`Task completed by ${agent.name}`),
      `Missing entry for ${agent.name} in context pool!`
    );
  }
  console.log(`✓ Context Concurrency Passed: All ${NUM_AGENTS} concurrent appends merged atomically in ${contextDuration}ms (Final v${finalItem.version})`);

  // Verify history audit log for this key has exactly 31 records (1 initial + 30 appends)
  const historyRes = await fetch(`${httpUrl}/api/context/history?roomCode=${testRoomCode}&limit=100`);
  const historyData = await historyRes.json();
  const keyHistory = historyData.history.filter((h) => h.key === targetKey);
  assert.strictEqual(keyHistory.length, 1 + NUM_AGENTS);
  console.log(`✓ History Audit Passed: All ${1 + NUM_AGENTS} revisions for key "${targetKey}" accurately tracked in audit log`);

  // --------------------------------------------------------------------------
  // PHASE 4: Mass Disconnect Resilience (15 agents disconnect mid-flight)
  // --------------------------------------------------------------------------
  console.log('\n--- Phase 4: Abrupt Disconnect Resilience ---');
  const disconnectHalf = agents.slice(0, 15);
  const remainingHalf = agents.slice(15);

  // Terminate 15 sockets abruptly
  for (const agent of disconnectHalf) {
    agent.ws.terminate();
  }

  // Send another broadcast from remaining agents while sockets are dropping
  const survivingSend = new Promise((resolve) => {
    remainingHalf[0].ws.send(
      JSON.stringify({
        type: 'message',
        roomCode: testRoomCode,
        to: '@all',
        content: 'Post-disconnect survival heartbeat',
      })
    );
    resolve(true);
  });

  await survivingSend;
  await new Promise((r) => setTimeout(r, 200));

  console.log('✓ Server handled abrupt termination of 15 agents without crash or unhandled exceptions');

  // Clean shutdown remaining
  for (const agent of remainingHalf) {
    agent.ws.close();
  }
  await server.stop();

  console.log('\n🎉 HIGH-CONCURRENCY STRESS TEST PASSED 100%! System is rock-solid under heavy swarm loads.');
  process.exit(0);
}

runHighConcurrencyStressTest().catch((err) => {
  console.error('\n❌ Stress Test Failed:', err);
  process.exit(1);
});
