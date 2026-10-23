// Tiny Streamable HTTP MCP client. The simulated Alexa+ agent uses this to talk to the LifeOS
// server over real HTTP — the same wire protocol Alexa+ uses — rather than calling tools in-process.
import { LATEST_PROTOCOL_VERSION } from './mcp.js';

export class McpClient {
  constructor(url, { token, clientInfo = { name: 'alexa-plus-simulator', version: '1.0.0' } } = {}) {
    this.url = url;
    this.token = token;
    this.clientInfo = clientInfo;
    this.sessionId = null;
    this.protocolVersion = LATEST_PROTOCOL_VERSION;
    this.nextId = 1;
    this.log = []; // every request/response, for the demo trace panel
  }

  async #post(message) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
    };
    if (this.sessionId) headers['MCP-Session-Id'] = this.sessionId;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    this.log.push({ dir: 'out', message });
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202) return null;

    const type = res.headers.get('content-type') || '';
    let body;
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      body = JSON.parse(data.at(-1));
    } else {
      body = await res.json();
    }
    this.log.push({ dir: 'in', status: res.status, message: body });
    if (res.status === 404 && this.sessionId) {
      // Session expired server-side: spec says start a new one.
      this.sessionId = null;
      throw Object.assign(new Error('MCP session expired'), { code: 'SESSION_EXPIRED' });
    }
    if (body.error) throw Object.assign(new Error(body.error.message), { rpc: body.error });
    return body.result;
  }

  request(method, params) {
    return this.#post({ jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) });
  }

  notify(method, params) {
    return this.#post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async connect() {
    const result = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo;
    this.instructions = result.instructions;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    return (await this.request('tools/list')).tools;
  }

  callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  async close() {
    if (!this.sessionId) return;
    const headers = { 'MCP-Session-Id': this.sessionId, 'MCP-Protocol-Version': this.protocolVersion };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    await fetch(this.url, { method: 'DELETE', headers }).catch(() => {});
    this.sessionId = null;
  }

  drainLog() {
    const out = this.log;
    this.log = [];
    return out;
  }
}
