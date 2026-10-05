import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAppServer } from '../codex-app-server.js';

function harness(executeTool, turnTimeoutMs) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const messages = [], spawnArgs = [];
  const emit = (message) => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  child.stdin = { writable: true, write: (line) => {
    const message = JSON.parse(line); messages.push(message);
    if (message.id != null && message.method) queueMicrotask(() => emit({ id: message.id, result:
      message.method === 'thread/start' ? { thread: { id: 'thread-test' } } : message.method === 'turn/start' ? { turn: { id: 'turn-test' } } : {} }));
  } };
  child.kill = () => child.emit('exit', 0);
  const server = new CodexAppServer({ cwd: process.cwd(), developerInstructions: 'test',
    dynamicTools: [{ type: 'function', name: 'jarvis_bots', description: 'test', inputSchema: { type: 'object', properties: {} } }], executeTool,
    spawnImpl: (...args) => { spawnArgs.push(args); return child; }, ...(turnTimeoutMs ? { turnTimeoutMs } : {}) });
  return { server, messages, spawnArgs, emit };
}

test('protocol registers tools, keeps read-only sandbox, and requests high Luna reasoning', async () => {
  const h = harness(async () => ({ bots: [] }));
  try {
    const threadId = await h.server.createThread('test');
    const initialize = h.messages.find((message) => message.method === 'initialize');
    assert.equal(initialize.params.capabilities.experimentalApi, true);
    const start = h.messages.find((message) => message.method === 'thread/start');
    assert.equal(start.params.dynamicTools[0].type, 'function');
    assert.equal(start.params.sandbox, 'read-only');
    assert.equal(start.params.config['features.shell_tool'], false);
    assert.equal(start.params.config['mcp_servers.node_repl.enabled'], false);
    assert.equal(Object.hasOwn(start.params.config, 'mcp_servers'), false);
    const answer = h.server.runTurn(threadId, 'test', null, { chatId: '123' });
    await new Promise((resolve) => setImmediate(resolve));
    const turn = h.messages.find((message) => message.method === 'turn/start');
    assert.equal(turn.params.model, 'gpt-6-luna'); assert.equal(turn.params.effort, 'high');
    assert.equal(turn.params.sandboxPolicy.networkAccess, false);
    h.emit({ method: 'turn/completed', params: { threadId, turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'done' }] } } });
    assert.equal(await answer, 'done');
  } finally { h.server.stop(); }
});

test('tool calls use trusted turn identity and protocol retries do not repeat side effects', async () => {
  let calls = 0, received;
  const h = harness(async (_name, _args, context) => { calls++; received = context; return { ok: true }; });
  try {
    await h.server.createThread('test');
    const answer = h.server.runTurn('thread-test', 'test', null, { chatId: '123', requestId: 'trusted' });
    await new Promise((resolve) => setImmediate(resolve));
    const params = { threadId: 'thread-test', turnId: 'turn-test', callId: 'call-one', tool: 'jarvis_bots', arguments: {} };
    h.emit({ id: 1000, method: 'item/tool/call', params });
    h.emit({ id: 1001, method: 'item/tool/call', params });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1); assert.equal(received.chatId, '123'); assert.equal(received.requestId, 'trusted');
    assert.equal(h.messages.find((m) => m.id === 1000 && m.result).result.contentItems[0].type, 'inputText');
    h.emit({ id: 1002, method: 'item/tool/call', params: { ...params, callId: 'other', threadId: 'unrelated' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.messages.find((m) => m.id === 1002 && m.result).result.success, false);
    h.emit({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { status: 'completed', items: [] } } });
    await answer; assert.equal(received.isActive(), false);
  } finally { h.server.stop(); }
});

test('tool errors become explicit failed results and expired turns are interrupted', async () => {
  const h = harness(async () => { throw new Error('Permission revoked'); }, 50);
  try {
    await h.server.createThread('test');
    const answer = h.server.runTurn('thread-test', 'test');
    await new Promise((resolve) => setImmediate(resolve));
    h.emit({ id: 1000, method: 'item/tool/call', params: { threadId: 'thread-test', turnId: 'turn-test', callId: 'call-one', tool: 'jarvis_bots', arguments: {} } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.messages.find((m) => m.id === 1000 && m.result).result.success, false);
    await assert.rejects(answer, /timed out/);
    assert.equal(h.messages.some((m) => m.method === 'turn/interrupt'), true);
  } finally { h.server.stop(); }
});
