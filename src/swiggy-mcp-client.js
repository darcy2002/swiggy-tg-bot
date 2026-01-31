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

const sessions = new Map();

async function ensureSession(baseUrl, token) {
  const key = baseUrl;
  if (sessions.get(key)) return sessions.get(key);
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token && { Authorization: `Bearer ${token}` }),
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
  const sessionId = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
  if (!sessionId) {
    const text = await res.text();
    throw new Error(`MCP initialize failed: no session id. ${res.status} ${text}`);
  }
  await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  sessions.set(key, { sessionId, baseUrl, token });
  return sessions.get(key);
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
  const { sessionId, baseUrl: url, token: t } = await ensureSession(baseUrl, token);
  const prefix = SESSION_PREFIX[serverKey];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...(t && { Authorization: `Bearer ${t}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
  });
  const data = await res.json();
  const tools = data?.result?.tools ?? [];
  return tools.map((t) => ({
    ...t,
    name: prefix + t.name,
    _server: serverKey,
    _originalName: t.name,
  }));
}

/**
 * List all tools from Food, Instamart, and Dineout (with prefixed names).
 */
export async function listAllTools(token) {
  const all = await Promise.all([
    listToolsForServer('swiggy_food', token).catch(() => []),
    listToolsForServer('swiggy_im', token).catch(() => []),
    listToolsForServer('swiggy_dineout', token).catch(() => []),
  ]);
  return all.flat();
}

/**
 * Call a single tool. claudeToolName must be prefixed (e.g. swiggy_food__search_restaurants).
 */
export async function callTool(claudeToolName, arguments_, token) {
  const parsed = getServerAndName(claudeToolName);
  if (!parsed) throw new Error(`Unknown tool server for: ${claudeToolName}`);
  const { server, name } = parsed;
  const baseUrl = SWIGGY_BASE_URLS[server];
  const { sessionId, token: t } = await ensureSession(baseUrl, token);
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...(t && { Authorization: `Bearer ${t}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: arguments_ || {} },
      id: 3,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const content = data?.result?.content ?? [];
  const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
  return textParts.length ? textParts.join('\n') : JSON.stringify(data.result);
}
