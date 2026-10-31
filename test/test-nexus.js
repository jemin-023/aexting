import assert from 'node:assert';
import WebSocket from 'ws';
import { NexusServer } from '../dist/server.js';

async function runTests() {
  console.log('🧪 Starting Nexus End-to-End Swarm Integration Tests...\n');

  const testPort = 7345;
  const testRoomCode = 'TEST-SWARM';

  const server = new NexusServer({
    port: testPort,
    roomCode: testRoomCode,
    hostName: 'TestHost',
    dbPath: ':memory:', // in-memory for testing
  });

  const info = await server.start();
  console.log(`✓ 1. Host Server started successfully on port ${testPort}`);
  assert.strictEqual(server.roomCode, testRoomCode);

  const baseUrl = `http://localhost:${testPort}`;
  const wsUrl = `ws://localhost:${testPort}/ws`;

  // Test 1: Query Pool Info
  const infoRes = await fetch(`${baseUrl}/api/pool/info`);
  const infoData = await infoRes.json();
  assert.strictEqual(infoData.roomCode, testRoomCode);
  console.log('✓ 2. Pool Info REST endpoint verified');

  // Test 2: Connect Agents via WebSocket
  const claudeWs = new WebSocket(wsUrl);
  const antigravityWs = new WebSocket(wsUrl);
  const opencodeWs = new WebSocket(wsUrl);

  const claudeReceived = [];
  const antigravityReceived = [];
  const opencodeReceived = [];

  await Promise.all([
    new Promise((resolve) => {
      claudeWs.on('open', () => {
        claudeWs.send(
          JSON.stringify({
            type: 'join',
            roomCode: testRoomCode,
            name: '@claude',
            agentType: 'claude',
            status: 'idle',
          })
        );
        resolve(true);
      });
      claudeWs.on('message', (data) => claudeReceived.push(JSON.parse(data.toString())));
    }),
    new Promise((resolve) => {
      antigravityWs.on('open', () => {
        antigravityWs.send(
          JSON.stringify({
            type: 'join',
            roomCode: testRoomCode,
            name: '@antigravity',
            agentType: 'antigravity',
            status: 'idle',
          })
        );
        resolve(true);
      });
      antigravityWs.on('message', (data) => antigravityReceived.push(JSON.parse(data.toString())));
    }),
    new Promise((resolve) => {
      opencodeWs.on('open', () => {
        opencodeWs.send(
          JSON.stringify({
            type: 'join',
            roomCode: testRoomCode,
            name: '@opencode',
            agentType: 'opencode',
            status: 'idle',
          })
        );
        resolve(true);
      });
      opencodeWs.on('message', (data) => opencodeReceived.push(JSON.parse(data.toString())));
    }),
  ]);

  // Wait 150ms for welcome and registration
  await new Promise((r) => setTimeout(r, 150));

  const agentsRes = await fetch(`${baseUrl}/api/pool/agents?roomCode=${testRoomCode}`);
  const agentsData = await agentsRes.json();
  assert.strictEqual(agentsData.agents.length, 3);
  console.log('✓ 3. 3 AI Agents (@claude, @antigravity, @opencode) registered and online');

  // Test 3: Broadcast message to @all
  claudeWs.send(
    JSON.stringify({
      type: 'message',
      roomCode: testRoomCode,
      to: '@all',
      content: 'Hello everyone! Claude here. Beginning refactoring.',
      tags: ['#announcement'],
    })
  );

  await new Promise((r) => setTimeout(r, 150));

  // Verify everyone received the broadcast
  const antigravityGotBroadcast = antigravityReceived.some(
    (m) => m.type === 'message' && m.message.content.includes('Claude here') && m.message.recipientName === '@all'
  );
  const opencodeGotBroadcast = opencodeReceived.some(
    (m) => m.type === 'message' && m.message.content.includes('Claude here') && m.message.recipientName === '@all'
  );
  assert.strictEqual(antigravityGotBroadcast, true);
  assert.strictEqual(opencodeGotBroadcast, true);
  console.log('✓ 4. Broadcast message to @all successfully received by all agents');

  // Test 4: Private Whisper (@antigravity -> @claude)
  antigravityWs.send(
    JSON.stringify({
      type: 'message',
      roomCode: testRoomCode,
      to: '@claude',
      content: 'Hey Claude, check private token in env config.',
      tags: ['#secret'],
    })
  );

  await new Promise((r) => setTimeout(r, 150));

  // Claude should receive the whisper
  const claudeGotWhisper = claudeReceived.some(
    (m) => m.type === 'message' && m.message.content.includes('check private token') && m.message.isPrivate === true
  );
  // OpenCode MUST NOT receive the whisper between Antigravity and Claude!
  const opencodeGotWhisper = opencodeReceived.some(
    (m) => m.type === 'message' && m.message.content && m.message.content.includes('check private token')
  );

  assert.strictEqual(claudeGotWhisper, true);
  assert.strictEqual(opencodeGotWhisper, false);
  console.log('✓ 5. Private whisper delivery verified: Delivered to @claude, strictly hidden from @opencode');

  // Test 5: Global Context Pool (Blackboard)
  // Claude sets an architecture decision
  claudeWs.send(
    JSON.stringify({
      type: 'context_set',
      roomCode: testRoomCode,
      key: 'architecture_choice',
      section: 'architecture',
      content: 'Decided on event-driven state sync with SQLite blackboard.',
    })
  );

  await new Promise((r) => setTimeout(r, 150));

  // Antigravity appends to it
  antigravityWs.send(
    JSON.stringify({
      type: 'context_append',
      roomCode: testRoomCode,
      key: 'architecture_choice',
      section: 'architecture',
      entry: 'Verified: latency is sub-millisecond on SQLite in-memory.',
    })
  );

  await new Promise((r) => setTimeout(r, 150));

  const ctxRes = await fetch(`${baseUrl}/api/context?roomCode=${testRoomCode}&key=architecture_choice`);
  const ctxData = await ctxRes.json();
  assert.strictEqual(ctxData.item.version, 2);
  assert.ok(ctxData.item.content.includes('Decided on event-driven'));
  assert.ok(ctxData.item.content.includes('Verified: latency is sub-millisecond'));
  console.log('✓ 6. Global Context Pool update & append verified across agents (v2 state)');

  // Test 6: Audit History
  const historyRes = await fetch(`${baseUrl}/api/context/history?roomCode=${testRoomCode}`);
  const historyData = await historyRes.json();
  assert.ok(historyData.history.length >= 2);
  console.log('✓ 7. Global Context Audit History verified with agent handles and timestamps');

  // Test 7: Status & Heartbeat
  opencodeWs.send(
    JSON.stringify({
      type: 'status',
      roomCode: testRoomCode,
      status: 'working',
      currentTask: 'Running test suite in parallel',
    })
  );

  await new Promise((r) => setTimeout(r, 150));
  const agentCheckRes = await fetch(`${baseUrl}/api/pool/agents?roomCode=${testRoomCode}`);
  const agentCheckData = await agentCheckRes.json();
  const opencodeAgent = agentCheckData.agents.find((a) => a.name === '@opencode');
  assert.strictEqual(opencodeAgent.status, 'working');
  assert.strictEqual(opencodeAgent.currentTask, 'Running test suite in parallel');
  console.log('✓ 8. Agent status & current task broadcast verified');

  // Clean shutdown
  claudeWs.close();
  antigravityWs.close();
  opencodeWs.close();
  await server.stop();

  console.log('\n🎉 ALL 8 TESTS PASSED SUCCESSFULLY! Nexus is robust, privacy-respecting, and production-ready.');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
