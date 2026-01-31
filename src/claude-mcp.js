/**
 * Claude + Swiggy MCP: natural language → Claude chooses tools → we call Swiggy MCP → results back to Claude → user-readable reply.
 * Flow: Telegram message → Claude (with Swiggy tool definitions) → Claude returns tool_use → we call MCP tools → tool results → Claude → final text → Telegram.
 */

import Anthropic from '@anthropic-ai/sdk';
import { listAllTools, callTool } from './swiggy-mcp-client.js';

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
- Keep responses suitable for chat: short paragraphs and bullet points when useful.`;

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
  if (cachedTools && cachedToolsToken === swiggyAuthToken) return cachedTools;
  const raw = await listAllTools(swiggyAuthToken);
  const tools = raw.map(mcpToolToClaudeTool);
  cachedTools = tools;
  cachedToolsToken = swiggyAuthToken;
  return tools;
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
  const tools = await getClaudeTools(swiggyAuthToken);
  if (tools.length === 0) {
    return {
      text: 'Swiggy tools could not be loaded. Check SWIGGY_AUTH_TOKEN and that MCP servers are reachable.',
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
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: currentMessages,
      tools,
      tool_choice: 'auto',
    });

    const textParts = [];
    const toolUses = [];

    for (const block of response.content) {
      if (block.type === 'text') textParts.push(block.text);
      if (block.type === 'tool_use') toolUses.push(block);
    }

    const text = textParts.join('').trim();
    if (response.stop_reason === 'end_turn' && text) {
      return { text, stopReason: 'end_turn' };
    }

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return {
        text: text || 'Done.',
        stopReason: response.stop_reason || 'end_turn',
      };
    }

    currentMessages.push({
      role: 'assistant',
      content: response.content,
    });

    const toolResults = [];
    for (const use of toolUses) {
      let content;
      try {
        const result = await callTool(use.name, use.input, swiggyAuthToken);
        content = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        content = `Error: ${err?.message || String(err)}`;
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

  return {
    text: "I hit the reply limit. Please try a shorter request or ask again.",
    stopReason: 'end_turn',
  };
}
