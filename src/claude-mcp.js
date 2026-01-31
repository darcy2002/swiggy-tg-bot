/**
 * Claude + Swiggy MCP: natural language → Claude chooses tools → we call Swiggy MCP → results back to Claude → user-readable reply.
 * Flow: Telegram message → Claude (with Swiggy tool definitions) → Claude returns tool_use → we call MCP tools → tool results → Claude → final text → Telegram.
 */

import Anthropic from '@anthropic-ai/sdk';
import { listAllTools, callTool } from './swiggy-mcp-client.js';

const log = {
  claude: (msg, ...args) => console.log(`[Claude] ${msg}`, ...args),
  claudeErr: (msg, ...args) => console.error(`[Claude] ${msg}`, ...args),
};

const SYSTEM_PROMPT = `You are a helpful Swiggy assistant inside a Telegram bot. You help the user order food (Swiggy Food), groceries (Instamart), or book tables (Dineout) using natural language.

You have access to Swiggy MCP tools (names are prefixed with swiggy_food__, swiggy_im__, or swiggy_dineout__). Use them to:
- **Swiggy Food**: Restaurant search, menu browsing, cart management, and food ordering (COD only).
- **Instamart**: Product search, cart, and grocery order placement (COD only).
- **Dineout**: Restaurant discovery, details, slot availability, and table booking (free bookings only).

Guidelines:
- Be concise and friendly; replies will be shown in Telegram.
- When the user wants to order or search, call the appropriate tools.
- If the user hasn't set a delivery/booking address, ask for it (e.g. "Use my home address").
- Before placing any order, summarize cart/order and confirm. Remind that COD orders cannot be cancelled once placed.
- After tool results, summarize in a short user-readable message.
- Keep responses suitable for chat: short paragraphs and bullet points when useful.

Important context usage:
- When showing restaurants, menu items, or search results to the user, ALWAYS include the ID in your response (e.g. "1. Starbucks (ID: 12345)"). This helps you reference them later.
- If the user has already been shown a list (restaurants, items, etc.) and is now selecting one by position (e.g. "the second one") or by name, use the ID from your previous response. Do not call search tools again—directly call the appropriate tool (get_restaurant_menu, add_to_cart, etc.) with the ID.
- Your previous responses in this conversation contain the IDs you need.`;

let cachedTools = null;
let cachedToolsToken = null;

function mcpToolToClaudeTool(t) {
  const schema = t.inputSchema ?? t.input_schema ?? t.schema ?? { type: 'object', properties: {} };
  return {
    name: t.name,
    description: t.description || `Swiggy MCP tool: ${t.name}`,
    input_schema: schema,
  };
}

async function getClaudeTools(swiggyAuthToken) {
  if (cachedTools && cachedToolsToken === swiggyAuthToken) {
    log.claude('using cached tools', { count: cachedTools.length });
    return cachedTools;
  }
  try {
    log.claude('loading Swiggy tools...');
    const raw = await listAllTools(swiggyAuthToken);
    const tools = raw.map(mcpToolToClaudeTool);
    cachedTools = tools;
    cachedToolsToken = swiggyAuthToken;
    log.claude('tools loaded', { count: tools.length, names: tools.slice(0, 5).map((t) => t.name).concat(tools.length > 5 ? ['...'] : []) });
    return tools;
  } catch (err) {
    log.claudeErr('tools load failed', err?.message || String(err));
    const msg = err?.message || String(err);
    throw new Error(`Swiggy tools could not be loaded. ${msg}`);
  }
}

/**
 * Build messages array for Claude API (content can be string or array of blocks).
 */
function toClaudeMessage(role, content) {
  if (typeof content === 'string') return { role, content };
  return { role, content };
}

/**
 * Send user message to Claude; on tool_use, call Swiggy MCP tools and resubmit until Claude returns text.
 */
export async function chatWithClaudeMcp({
  userMessage,
  swiggyAuthToken,
  previousMessages = [],
}) {
  const anthropic = new Anthropic();
  let tools;
  try {
    tools = await getClaudeTools(swiggyAuthToken);
  } catch (err) {
    log.claudeErr('cannot proceed without tools', err?.message);
    return {
      text: err?.message || 'Swiggy tools could not be loaded. Check SWIGGY_AUTH_TOKEN and that MCP servers are reachable.',
      stopReason: 'end_turn',
    };
  }
  if (tools.length === 0) {
    log.claudeErr('no tools returned from MCP servers');
    return {
      text: 'Swiggy tools could not be loaded. No tools returned from MCP servers. Check SWIGGY_AUTH_TOKEN.',
      stopReason: 'end_turn',
    };
  }

  const messages = [
    ...previousMessages.map((m) => toClaudeMessage(m.role, m.content)),
    { role: 'user', content: userMessage },
  ];

  const maxRounds = 15;
  let currentMessages = [...messages];

  for (let round = 0; round < maxRounds; round++) {
    log.claude('round', round + 1, 'calling Messages API...');
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: currentMessages,
      tools,
      tool_choice: { type: 'auto' },
    });

    const textParts = [];
    const toolUses = [];

    for (const block of response.content) {
      if (block.type === 'text') textParts.push(block.text);
      if (block.type === 'tool_use') toolUses.push(block);
    }

    const text = textParts.join('').trim();
    log.claude('round', round + 1, 'stop_reason=', response.stop_reason, 'tool_uses=', toolUses.length, 'textLen=', text.length);

    if (response.stop_reason === 'end_turn' && text) {
      log.claude('done: returning text to user');
      log.claude('usage:', { input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens });
      // Store only plain text in history to avoid tool_use/tool_result chain issues
      return { text, stopReason: 'end_turn', usage: response.usage };
    }

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      log.claude('done: no more tool_use', response.stop_reason || '');
      log.claude('usage:', { input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens });
      return {
        text: text || 'Done.',
        stopReason: response.stop_reason || 'end_turn',
        usage: response.usage,
      };
    }

    currentMessages.push({
      role: 'assistant',
      content: response.content,
    });

    const toolResults = [];
    for (const use of toolUses) {
      log.claude('calling MCP tool', use.name, 'inputKeys:', Object.keys(use.input || {}));
      let content;
      try {
        const result = await callTool(use.name, use.input, swiggyAuthToken);
        content = typeof result === 'string' ? result : JSON.stringify(result);
        log.claude('tool result', use.name, 'ok, resultLength=', content.length);
      } catch (err) {
        content = `Error: ${err?.message || String(err)}`;
        log.claudeErr('tool failed', use.name, err?.message || String(err));
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content,
      });
    }

    currentMessages.push({
      role: 'user',
      content: toolResults,
    });
  }

  log.claudeErr('hit max rounds without end_turn');

  const limitMsg = "I hit the reply limit. Please try a shorter request or ask again.";
  return {
    text: limitMsg,
    stopReason: 'end_turn',
    usage: null,
  };
}
