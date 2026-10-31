import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NexusServer } from '../dist/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMcpQa() {
  console.log('🧪 [QA TEST 1] Model Context Protocol (MCP) Protocol & Tool Verification\n');

  const testPort = 7350;
  const testRoomCode = 'MCP-QA-POOL';

  // 1. Start Nexus Host
  const server = new NexusServer({
    port: testPort,
    roomCode: testRoomCode,
    hostName: 'McpQAH唆',
    dbPath: ':memory:',
  });

  await server.start();
  console.log(`✓ 1. Nexus Host started for MCP QA on port ${testPort}`);

  // 2. Connect via StdioClientTransport to bin/nexus-mcp.js
  const mcpScriptPath = path.resolve(__dirname, '../dist/mcp.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      mcpScriptPath,
      '--host', `http://localhost:${testPort}`,
      '--code', testRoomCode,
      '--name', '@qa_claude',
      '--type', 'claude',
    ],
  });

  const client = new Client(
    { name: 'mcp-qa-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('✓ 2. MCP Client connected over stdio to nexus-mcp server');

  // 3. Verify Tool Listing (tools/list)
  const toolsResult = await client.listTools();
  const tools = toolsResult.tools || [];
  console.log(`✓ 3. Discovered ${tools.length} MCP tools:`);
  for (const t of tools) {
    console.log(`     - ${t.name}: ${t.description.slice(0, 60)}...`);
  }

  const expectedToolNames = [
    'aexting_send_message',
    'aexting_read_messages',
    'aexting_get_global_context',
    'aexting_set_global_context',
    'aexting_append_global_context',
    'aexting_list_agents',
    'aexting_update_status',
    'nexus_send_message',
    'nexus_read_messages',
    'nexus_get_global_context',
    'nexus_set_global_context',
    'nexus_append_global_context',
    'nexus_list_agents',
    'nexus_update_status',
  ];

  for (const name of expectedToolNames) {
    assert.ok(tools.some((t) => t.name === name), `Missing expected MCP tool: ${name}`);
  }
  assert.strictEqual(tools.length, 14, 'Expected exactly 14 MCP tools (7 aexting + 7 backward-compatible aliases)');

  // 4. Test Tool: nexus_update_status
  console.log('\n--- Testing MCP Tool Invocations ---');
  const statusRes = await client.callTool({
    name: 'nexus_update_status',
    arguments: {
      status: 'working',
      current_task: 'Running MCP tool conformance suite',
    },
  });
  assert.ok(!statusRes.isError);
  console.log('✓ 4. nexus_update_status executed successfully');

  // 5. Test Tool: nexus_list_agents
  const listRes = await client.callTool({
    name: 'nexus_list_agents',
    arguments: {},
  });
  assert.ok(!listRes.isError);
  const listText = listRes.content[0].text;
  assert.ok(listText.includes('@qa_claude'));
  console.log('✓ 5. nexus_list_agents executed: confirmed @qa_claude presence');

  // 6. Test Tool: nexus_send_message (Broadcast to @all)
  const sendRes = await client.callTool({
    name: 'nexus_send_message',
    arguments: {
      to: '@all',
      message: 'MCP protocol conformance check: broadcast active.',
      tags: ['#qa', '#mcp'],
    },
  });
  assert.ok(!sendRes.isError);
  console.log('✓ 6. nexus_send_message (@all) executed successfully');

  // 7. Test Tool: nexus_send_message (Private whisper)
  const whisperRes = await client.callTool({
    name: 'nexus_send_message',
    arguments: {
      to: '@antigravity',
      message: 'Secret token from MCP client.',
      tags: ['#whisper'],
    },
  });
  assert.ok(!whisperRes.isError);
  console.log('✓ 7. nexus_send_message (private whisper) executed successfully');

  // 8. Test Tool: nexus_read_messages
  const readRes = await client.callTool({
    name: 'nexus_read_messages',
    arguments: {
      limit: 10,
    },
  });
  assert.ok(!readRes.isError);
  const readText = readRes.content[0].text;
  assert.ok(readText.includes('MCP protocol conformance check'));
  console.log('✓ 8. nexus_read_messages executed: retrieved sent broadcast');

  // 9. Test Tool: nexus_set_global_context
  const setCtxRes = await client.callTool({
    name: 'nexus_set_global_context',
    arguments: {
      key: 'mcp_spec_test',
      section: 'specs',
      content: 'Standard MCP stdio transport compliant',
    },
  });
  assert.ok(!setCtxRes.isError);
  console.log('✓ 9. nexus_set_global_context executed successfully');

  // 10. Test Tool: nexus_get_global_context (Specific key)
  const getCtxRes = await client.callTool({
    name: 'nexus_get_global_context',
    arguments: {
      key: 'mcp_spec_test',
    },
  });
  assert.ok(!getCtxRes.isError);
  const getCtxText = getCtxRes.content[0].text;
  assert.ok(getCtxText.includes('Standard MCP stdio transport compliant'));
  console.log('✓ 10. nexus_get_global_context (key) executed successfully');

  // 11. Test Tool: nexus_append_global_context
  const appendRes = await client.callTool({
    name: 'nexus_append_global_context',
    arguments: {
      key: 'mcp_spec_test',
      entry: 'Appended assertion: sub-millisecond execution verified.',
    },
  });
  assert.ok(!appendRes.isError);
  console.log('✓ 11. nexus_append_global_context executed successfully');

  // 12. Test Tool: nexus_get_global_context (All items)
  const getAllRes = await client.callTool({
    name: 'nexus_get_global_context',
    arguments: {},
  });
  assert.ok(!getAllRes.isError);
  const getAllText = getAllRes.content[0].text;
  assert.ok(getAllText.includes('mcp_spec_test'));
  assert.ok(getAllText.includes('Appended assertion'));
  console.log('✓ 12. nexus_get_global_context (all) verified composite output');

  // Cleanup
  await transport.close();
  await server.stop();

  console.log('\n🎉 MCP QA TEST SUITE COMPLETED WITH 100% SUCCESS!');
  process.exit(0);
}

runMcpQa().catch((err) => {
  console.error('\n❌ MCP QA Test Failed:', err);
  process.exit(1);
});
