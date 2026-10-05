import { spawn } from 'node:child_process';

const MODEL = 'gpt-6-luna';
const REASONING_EFFORT = 'high';
const TURN_TIMEOUT_MS = 600_000;
const RPC_TIMEOUT_MS = 30_000;
// Dynamic tools run in our permission-checked broker. Disable inherited general-purpose tools.
const TOOL_CONFIG = {
  'features.shell_tool': false, 'features.unified_exec': false, 'features.shell_snapshot': false, 'features.apps': false,
  'features.plugins': false, 'features.browser_use': false, 'features.computer_use': false,
  'features.browser_use_external': false, 'features.in_app_browser': false, 'features.view_image': false,
  'features.skill_search': false, 'features.workspace_dependencies': false,
  'features.multi_agent': false, 'features.hooks': false, 'features.image_generation': false,
  'features.code_mode': false, web_search: 'disabled',
  'mcp_servers.node_repl.enabled': false,
};

export class CodexAppServer {
  constructor({ cwd, developerInstructions, dynamicTools = [], executeTool, spawnImpl = spawn, turnTimeoutMs = TURN_TIMEOUT_MS }) {
    this.cwd = cwd;
    this.developerInstructions = developerInstructions;
    this.dynamicTools = dynamicTools;
    this.executeTool = executeTool;
    this.spawn = spawnImpl;
    this.turnTimeoutMs = turnTimeoutMs;
    this.toolConfig = { ...TOOL_CONFIG };
    this.child = null;
    this.startPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.stdoutBuffer = '';
  }

  async start() {
    if (this.child && this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start(disabledServers = []) {
    const overrides = [...Object.entries(TOOL_CONFIG), ...disabledServers.map((name) => [`mcp_servers.${name}.enabled`, false])].flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
    const child = this.spawn(process.env.CODEX_EXE || 'codex', ['app-server', '--listen', 'stdio://', ...overrides], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TELEGRAM_BOT_TOKEN: undefined },
    });
    this.child = child;
    this.ready = false;
    this.stdoutBuffer = '';
    child.stdout.on('data', (chunk) => { if (this.child === child) this.#onStdout(chunk); });
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message && this.child === child) console.warn(`Codex app-server: ${message.slice(0, 500)}`);
    });
    child.on('error', (error) => { if (this.child === child) this.#failAll(new Error(`Could not start local Codex app-server (${error.code ?? error.name}).`)); });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.ready = false;
      this.child = null;
      this.#failAll(new Error(`Local Codex app-server stopped (${signal ?? code ?? 'unknown'}).`));
    });

    try {
      const response = await this.#request('initialize', {
        clientInfo: { name: 'wikimasters-jarvis', title: 'WikiMasters Jarvis', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      if (!response) throw new Error('Local Codex app-server did not initialize.');
      this.#notify('initialized', {});
      // Empty maps merge with inherited TOML tables. Explicitly disable each configured MCP server.
      const settings = await this.#request('config/read', { includeLayers: false });
      const configuredServers = Object.keys(settings.config?.mcp_servers ?? {});
      if (configuredServers.some((name) => !disabledServers.includes(name))) {
        this.child = null; child.kill();
        return this.#start(configuredServers);
      }
      this.toolConfig = { ...TOOL_CONFIG };
      for (const name of configuredServers) this.toolConfig[`mcp_servers.${name}.enabled`] = false;
      this.ready = true;
    } catch (error) {
      if (this.child === child) this.child = null;
      child.kill();
      throw error;
    }
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error('Local Codex app-server is not available.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  #request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local Codex request timed out (${method}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #notify(method, params) {
    this.#write({ method, params });
  }

  #onStdout(chunk) {
    this.stdoutBuffer += String(chunk);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        console.warn('Local Codex app-server returned an unreadable protocol message.');
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? `${pending.method} failed.`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      if (message.method === 'item/tool/call') void this.#handleToolCall(message);
      else this.#write({ id: message.id, error: { code: -32601, message: 'Server request is not supported by Jarvis.' } });
      return;
    }
    const params = message.params ?? {};
    const turn = this.turns.get(params.threadId);
    if (!turn) return;
    if (message.method === 'item/agentMessage/delta') {
      const itemId = params.itemId ?? 'answer';
      turn.items.set(itemId, `${turn.items.get(itemId) ?? ''}${params.delta ?? ''}`);
    } else if (message.method === 'turn/completed') {
      this.turns.delete(params.threadId);
      clearTimeout(turn.timer);
      if (params.turn?.status !== 'completed') {
        const detail = params.turn?.error?.message ?? params.turn?.status ?? 'unknown status';
        turn.reject(new Error(`Codex turn ${detail}.`));
      } else {
        const streamed = [...turn.items.values()].join('\n').trim();
        const finalItem = [...(params.turn?.items ?? [])].reverse().find((item) => item.type === 'agentMessage' && item.text?.trim());
        turn.resolve(finalItem?.text?.trim() || streamed || 'Luna finished without a text reply.');
      }
    }
  }

  async #handleToolCall(message) {
    const params = message.params ?? {}, turn = this.turns.get(params.threadId);
    let result;
    try {
      if (!turn || !this.executeTool || params.namespace || turn.turnId && params.turnId !== turn.turnId
        || !this.dynamicTools.some((tool) => tool.name === params.tool) || !params.callId) throw new Error('This tool call is not authorized for an active Jarvis request.');
      // A protocol retry must not duplicate a target change, listing cancellation, or bot cycle.
      const key = `${params.turnId}:${params.callId}`;
      if (!turn.toolCalls.has(key)) {
        if (turn.toolCalls.size >= 60) throw new Error('This request reached the 60-tool limit. Narrow the task.');
        const context = { ...turn.context, isActive: () => this.turns.get(params.threadId) === turn };
        turn.toolCalls.set(key, Promise.resolve().then(() => this.executeTool(params.tool, params.arguments, context))
          .then((value) => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] }))
          .catch((error) => ({ success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: String(error.message).slice(0, 1000) }) }] })));
      }
      result = await turn.toolCalls.get(key);
    } catch (error) {
      result = { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.message }) }] };
    }
    try { this.#write({ id: message.id, result }); } catch {}
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.turns.clear();
  }

  async createThread(name, { ephemeral = false } = {}) {
    await this.start();
    const result = await this.#request('thread/start', {
      model: MODEL,
      cwd: this.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral,
      threadSource: 'telegram',
      developerInstructions: this.developerInstructions,
      dynamicTools: this.dynamicTools,
      config: this.toolConfig,
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error('Codex did not return a persistent thread ID.');
    await this.#verifyIsolation(threadId);
    if (!ephemeral) await this.#request('thread/name/set', { threadId, name });
    return threadId;
  }

  async resumeThread(threadId) {
    await this.start();
    const result = await this.#request('thread/resume', {
      threadId,
      cwd: this.cwd,
      model: MODEL,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      developerInstructions: this.developerInstructions,
      config: this.toolConfig,
    });
    await this.#verifyIsolation(threadId);
    return result;
  }

  async #verifyIsolation(threadId) {
    let cursor;
    do {
      const inventory = await this.#request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
      const inherited = (inventory.data ?? []).filter((server) => Object.keys(server.tools ?? {}).length || server.runtimeStatus === 'connected' || server.runtimeStatus === 'starting');
      if (inherited.length) throw new Error(`Jarvis inherited an external tool server (${inherited.map((server) => server.name).join(', ')}). Its connection is blocked until tool isolation is restored.`);
      cursor = inventory.nextCursor;
    } while (cursor);
  }

  async readConversation(threadId) {
    await this.start();
    const result = await this.#request('thread/read', { threadId, includeTurns: true });
    const lines = [];
    for (const turn of (result.thread?.turns ?? []).slice(-8)) for (const item of turn.items ?? []) {
      if (item.type === 'agentMessage' && item.text) lines.push(`Assistant: ${item.text.slice(0, 2500)}`);
      if (item.type === 'userMessage') {
        const message = (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        if (message) lines.push(`User: ${message.slice(0, 2500)}`);
      }
    }
    return lines.join('\n').slice(-12_000);
  }

  async runTurn(threadId, text, imagePath = null, context = {}) {
    await this.start();
    if (this.turns.has(threadId)) throw new Error('This Jarvis conversation is already handling a question. Try again shortly.');
    const input = [{ type: 'text', text }];
    if (imagePath) input.push({ type: 'localImage', path: imagePath });

    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const expired = this.turns.get(threadId);
        this.turns.delete(threadId);
        if (expired?.turnId) void this.#request('turn/interrupt', { threadId, turnId: expired.turnId }).catch(() => {});
        reject(new Error('Luna timed out after 10 minutes. Any completed changes remain in the change history.'));
      }, this.turnTimeoutMs);
      this.turns.set(threadId, { resolve, reject, timer, items: new Map(), toolCalls: new Map(), context });
    });
    // A timeout can occur while turn/start itself is still waiting for its RPC response.
    completion.catch(() => {});

    try {
      const started = await this.#request('turn/start', {
        threadId,
        input,
        cwd: this.cwd,
        model: MODEL,
        effort: REASONING_EFFORT,
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never',
      });
      const active = this.turns.get(threadId);
      if (active) active.turnId = started.turn?.id;
    } catch (error) {
      const turn = this.turns.get(threadId);
      if (turn) {
        this.turns.delete(threadId);
        clearTimeout(turn.timer);
        turn.reject(error);
      }
    }
    return completion;
  }

  stop() {
    this.ready = false;
    this.child?.kill();
    this.child = null;
    this.#failAll(new Error('Local Codex app-server stopped.'));
  }
}
