/**
 * Claude API client with Swiggy MCP connector.
 * Uses Anthropic Messages API beta (mcp-client-2025-11-20) for MCP tools.
 * @see https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
 * @see https://github.com/Swiggy/swiggy-mcp-server-manifest
 */

import Anthropic from '@anthropic-ai/sdk';

const MCP_BETA = 'mcp-client-2025-11-20';

const SWIGGY_MCP_SERVERS = [
  { type: 'url', url: 'https://mcp.swiggy.com/food', name: 'swiggy-food' },
  { type: 'url', url: 'https://mcp.swiggy.com/im', name: 'swiggy-instamart' },
  { type: 'url', url: 'https://mcp.swiggy.com/dineout', name: 'swiggy-dineout' },
];

const SWIGGY_MCP_TOOLS = [
  { type: 'mcp_toolset', mcp_server_name: 'swiggy-food' },
  { type: 'mcp_toolset', mcp_server_name: 'swiggy-instamart' },
  { type: 'mcp_toolset', mcp_server_name: 'swiggy-dineout' },
];

const SYSTEM_PROMPT = `You are a helpful Swiggy assistant inside a Telegram bot. You help the user order food (Swiggy Food), groceries (Instamart), or book tables (Dineout) using natural language.

You have access to Swiggy MCP tools for:
- **Swiggy Food**: Restaurant search, menu browsing, cart management, and food ordering (COD only).
- **Instamart**: Product search, cart, and grocery order placement (COD only).
- **Dineout**: Restaurant discovery, details, slot availability, and table booking (free bookings only).

Guidelines:
- Be concise and friendly; replies will be shown in Telegram.
- When the user wants to order or search, use the appropriate MCP tools.
- If the user hasn't set a delivery/booking address, ask for it (e.g. "Use my home address").
- Before placing any order, summarize cart/order and confirm. Remind that COD orders cannot be cancelled once placed.
- If something fails or auth is needed, explain clearly.
- Keep responses suitable for chat: short paragraphs and bullet points when useful.`;

function buildMcpServers(authorizationToken) {
  return SWIGGY_MCP_SERVERS.map((server) => ({
    ...server,
    ...(authorizationToken && { authorization_token: authorizationToken }),
  }));
}

/**
 * Send a user message to Claude with Swiggy MCP tools; returns the assistant's text.
 * @param {Object} options
 * @param {string} options.userMessage - The user's message (e.g. from Telegram).
 * @param {string} [options.swiggyAuthToken] - Optional Swiggy OAuth token for MCP.
 * @param {Array<{ role: string, content: string }>} [options.previousMessages] - Optional conversation history.
 */
export async function chatWithClaudeMcp({
  userMessage,
  swiggyAuthToken,
  previousMessages = [],
}) {
  const anthropic = new Anthropic();
  const mcpServers = buildMcpServers(swiggyAuthToken);
  const messages = [
    ...previousMessages,
    { role: 'user', content: userMessage },
  ];

  const response = await anthropic.beta.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
    mcp_servers: mcpServers,
    tools: SWIGGY_MCP_TOOLS,
    betas: [MCP_BETA],
  });

  const textParts = [];
  for (const block of response.content) {
    if (block.type === 'text') textParts.push(block.text);
  }
  const text = textParts.join('').trim();

  if (text) return { text, stopReason: response.stop_reason };

  if (response.stop_reason === 'tool_use') {
    return {
      text: "I'm using Swiggy tools to help you. This can take a moment—please send your message again in a few seconds, or try being more specific (e.g. add your delivery address).",
      stopReason: response.stop_reason,
    };
  }

  return { text: 'Done.', stopReason: response.stop_reason };
}
