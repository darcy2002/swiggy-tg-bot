/**
 * MCP Streamable HTTP client for Swiggy MCP servers.
 * Initialize session, list tools, call tools. One session per base URL.
 * @see https://modelcontextprotocol.io/specification (Streamable HTTP)
 */

const SWIGGY_BASE_URLS = {
  swiggy_food: 'https://mcp.swiggy.com/food',
  swiggy_im: 'https://mcp.swiggy.com/im',
  swiggy_dineout: 'https://mcp.swiggy.com/dineout',
};

const SESSION_PREFIX = {
  swiggy_food: 'swiggy_food__',
  swiggy_im: 'swiggy_im__',
  swiggy_dineout: 'swiggy_dineout__',
};

const log = {
  mcp: (msg, ...args) => console.log(`[MCP] ${msg}`, ...args),
  mcpErr: (msg, ...args) => console.error(`[MCP] ${msg}`, ...args),
};

const connections = new Map();

/**
 * Swiggy MCP returns initialize result in body but no session id in headers (stateless HTTP).
 * We store { baseUrl, token, sessionId: null } and omit Mcp-Session-Id on tools/list and tools/call.
 */
async function ensureConnection(baseUrl, token) {
  const key = baseUrl;
  if (connections.get(key)) return connections.get(key);
  if (!token) {
    throw new Error('SWIGGY_AUTH_TOKEN is required. Add your Swiggy OAuth access_token to .env');
  }
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'swiggy-tg-bot', version: '1.0.0' },
      },
      id: 1,
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (body?.error) {
    log.mcpErr('initialize failed', baseUrl, body.error.message || JSON.stringify(body.error));
    throw new Error(`MCP initialize failed: ${body.error.message || JSON.stringify(body.error)}`);
  }
  if (!res.ok) {
    log.mcpErr('initialize HTTP', res.status, baseUrl, text.slice(0, 150));
    throw new Error(`MCP initialize HTTP ${res.status}. ${text.slice(0, 200)}`);
  }
  const sessionId = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
  if (sessionId) {
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }
  connections.set(key, { sessionId: sessionId || null, baseUrl, token });
  log.mcp('connected', baseUrl, sessionId ? 'with session' : 'stateless');
  return connections.get(key);
}

function requestHeaders(conn) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${conn.token}`,
  };
  if (conn.sessionId) h['Mcp-Session-Id'] = conn.sessionId;
  return h;
}

function getServerAndName(claudeToolName) {
  for (const [server, prefix] of Object.entries(SESSION_PREFIX)) {
    if (claudeToolName.startsWith(prefix)) {
      const name = claudeToolName.slice(prefix.length);
      return { server, name };
    }
  }
  return null;
}

/**
 * Call tools/list on one Swiggy MCP server and return tools with prefixed names.
 */
export async function listToolsForServer(serverKey, token) {
  const baseUrl = SWIGGY_BASE_URLS[serverKey];
  if (!baseUrl) return [];
  const conn = await ensureConnection(baseUrl, token);
  const prefix = SESSION_PREFIX[serverKey];
  const res = await fetch(conn.baseUrl, {
    method: 'POST',
    headers: requestHeaders(conn),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
  });
  const rawText = await res.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(`tools/list invalid JSON (${serverKey}): ${rawText.slice(0, 150)}`);
  }
  if (data?.error) {
    throw new Error(`${serverKey} tools/list: ${data.error.message || JSON.stringify(data.error)}`);
  }
  const result = data?.result;
  const tools = Array.isArray(result?.tools) ? result.tools : Array.isArray(result) ? result : [];
  log.mcp('listTools', serverKey, 'count=', tools.length);
  return tools.map((tool) => ({
    ...tool,
    name: prefix + (tool.name || 'unknown'),
    _server: serverKey,
    _originalName: tool.name,
  }));
}

/**
 * List all tools from Food, Instamart, and Dineout (with prefixed names).
 */
export async function listAllTools(token) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('SWIGGY_AUTH_TOKEN is missing or empty. Set it in .env with your Swiggy OAuth access_token.');
  }
  const errors = [];
  const results = await Promise.allSettled([
    listToolsForServer('swiggy_food', token),
    listToolsForServer('swiggy_im', token),
    listToolsForServer('swiggy_dineout', token),
  ]);
  const all = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = ['swiggy_food', 'swiggy_im', 'swiggy_dineout'][i];
    if (r.status === 'fulfilled') {
      all.push(...r.value);
    } else {
      errors.push(`${name}: ${r.reason?.message || String(r.reason)}`);
    }
  }
  if (all.length === 0 && errors.length > 0) {
    log.mcpErr('listAllTools: no tools loaded', errors.join('; '));
    throw new Error(`Could not load any Swiggy tools. ${errors.join('; ')}`);
  }
  log.mcp('listAllTools total', all.length);
  return all;
}

/**
 * Call a single tool. claudeToolName must be prefixed (e.g. swiggy_food__search_restaurants).
 */
export async function callTool(claudeToolName, arguments_, token) {
  const parsed = getServerAndName(claudeToolName);
  if (!parsed) throw new Error(`Unknown tool server for: ${claudeToolName}`);
  const { server, name } = parsed;
  const baseUrl = SWIGGY_BASE_URLS[server];
  const conn = await ensureConnection(baseUrl, token);
  const res = await fetch(conn.baseUrl, {
    method: 'POST',
    headers: requestHeaders(conn),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: arguments_ || {} },
      id: 3,
    }),
  });
  const rawText = await res.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(`tools/call invalid JSON: ${rawText.slice(0, 150)}`);
  }
  if (data?.error) {
    log.mcpErr('callTool', name, 'error=', data.error.message);
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  const content = data?.result?.content ?? [];
  const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
  const out = textParts.length ? textParts.join('\n') : JSON.stringify(data.result);
  log.mcp('callTool', name, 'server=', server, 'resultLength=', out.length);
  return out;
}
