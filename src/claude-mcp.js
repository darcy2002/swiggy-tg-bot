/**
 * Claude + Swiggy MCP: natural language → Claude chooses tools → we call Swiggy MCP → results back to Claude → user-readable reply.
 * Flow: Telegram message → Claude (with Swiggy tool definitions) → Claude returns tool_use → we call MCP tools → tool results → Claude → final text → Telegram.
 */

import Anthropic from '@anthropic-ai/sdk';
import { listAllTools, callTool, clearConnectionCache } from './swiggy-mcp-client.js';

const log = {
  claude: (msg, ...args) => console.log(`\x1b[33m[Claude]\x1b[0m ${msg}`, ...args),
  claudeErr: (msg, ...args) => console.error(`\x1b[31m[Claude]\x1b[0m ${msg}`, ...args),
  tool: (name, status = 'ok') => {
    const short = name.replace(/^swiggy_(food|im|dineout)__/, '');
    const icon = status === 'ok' ? '🔧' : '❌';
    console.log(`  \x1b[90m→\x1b[0m ${icon} \x1b[1m${short}\x1b[0m`);
  },
  step: (msg) => console.log(`  \x1b[90m→\x1b[0m ${msg}`),
};

const SYSTEM_PROMPT = `You are a helpful Swiggy assistant inside a Telegram bot. You help the user order food (Swiggy Food), groceries (Instamart), or book tables (Dineout) using natural language.

You have access to Swiggy MCP tools (names are prefixed with swiggy_food__, swiggy_im__, or swiggy_dineout__). Use them to:
- **Swiggy Food**: Restaurant search, menu browsing, cart management, and food ordering (COD only).
- **Instamart**: Product search, cart, and grocery order placement (COD only).
- **Dineout**: Restaurant discovery, details, slot availability, and table booking (free bookings only).

Guidelines:
- Be concise and friendly; replies will be shown in Telegram.
- FORMAT your responses for Telegram using HTML: <b>bold</b> for names/headings, <i>italic</i> for emphasis. Use • or - for bullet points. Example format:
  <b>Restaurants near you:</b>
  • <b>1. Starbucks</b> (ID: 123) — 4.2★
  • <b>2. Blue Tokai</b> (ID: 456) — 4.5★
  For menu items: <b>Item name</b> — ₹price. Escape & as &amp; and < as &lt; in regular text. Never use unclosed HTML tags.
- When the user wants to order or search, call the appropriate tools.
- If the user hasn't set a delivery/booking address, ask for it (e.g. "Use my home address").
- Before placing any order, summarize cart/order and confirm. Remind that COD orders cannot be cancelled once placed.
- After tool results, summarize in a short user-readable message.
- Keep responses suitable for chat: short paragraphs and bullet points when useful.

Important context usage:
- When showing restaurants, menu items, or search results to the user, ALWAYS include the ID in your response (e.g. "1. Starbucks (ID: 12345)"). This helps you reference them later.
- If the user has already been shown a list (restaurants, items, etc.) and is now selecting one by position (e.g. "the second one") or by name, use the ID from your previous response. Do not call search tools again—directly call the appropriate tool (get_restaurant_menu, update_food_cart, etc.) with the ID.
- Session context: When [Session context] is shown with addressId, restaurantId, or cartId, USE those IDs directly. Do NOT call get_addresses or search_restaurants to re-fetch—they are already in session. Only call get_addresses if no addressId is in session and the user needs to add items.

CRITICAL - Order placement and tool usage:
- When the user CONFIRMS an order (says "yes", "confirm", "place it", "go ahead", "place order", etc.) after you showed a cart/order summary, you MUST call the place_order or checkout tool. Do NOT respond with "Order placed!" without calling the tool—that is a hallucination.
- To place a food order: call swiggy_food__place_food_order (or place_order/checkout) with addressId, restaurantId, and cartId—all three are required. Use the values from [Session context]. For Instamart: swiggy_im__place_order or swiggy_im__checkout. For Dineout: swiggy_dineout__book_table.
- NEVER claim an order was placed, a booking was confirmed, or payment succeeded UNLESS you actually called the order/checkout/book tool and the tool result explicitly indicates success.
- Tool result interpretation: Swiggy may return root-level success:true and message:"Order placed!" even when the order failed. ALWAYS check data.successful and data.statusMessage. If data.successful is false or data.statusMessage contains an error, the order FAILED—report that error to the user, do NOT claim success.
- If the user confirms and you don't call the order tool, your response will be rejected. Always call the tool first.
- When the tool fails, report the error to the user—do NOT say it succeeded.`;

let cachedTools = null;
let cachedToolsToken = null;

/** Clear tools and connection cache (call when token changes). */
export function clearCaches() {
  cachedTools = null;
  cachedToolsToken = null;
  clearConnectionCache();
}

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
  try {
    const raw = await listAllTools(swiggyAuthToken);
    const tools = raw.map(mcpToolToClaudeTool);
    cachedTools = tools;
    cachedToolsToken = swiggyAuthToken;
    log.claude(`Loaded ${tools.length} Swiggy tools`);
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
  sessionState = {},
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

  const isOrderConfirmation = /^(yes|yeah|yep|ok|okay|confirm|place\s*it|go\s*ahead|place\s*order|do\s*it|proceed)$/i.test(userMessage.trim());
  let userContent = isOrderConfirmation
    ? `${userMessage}\n\n[IMPORTANT: User is confirming the order. You MUST call the place_order or checkout tool now to complete the order. Do not respond with success text without calling the tool first.]`
    : userMessage;

  const ctx = sessionState;
  const hasContext = ctx.addressId || ctx.restaurantId || ctx.cartId || (ctx.addresses?.length > 0) || (ctx.restaurants?.length > 0);
  if (hasContext) {
    const parts = ['\n\n[Session context - USE these IDs. Do NOT call get_addresses or search_restaurants to re-fetch them:'];
    if (ctx.addressId) parts.push(` addressId=${ctx.addressId}`);
    if (ctx.restaurantId) parts.push(` restaurantId=${ctx.restaurantId}`);
    if (ctx.cartId) parts.push(` cartId=${ctx.cartId}`);
    if (ctx.addresses?.length) parts.push(` (${ctx.addresses.length} addresses available)`);
    if (ctx.restaurants?.length) parts.push(` (${ctx.restaurants.length} restaurants from last search)`);
    parts.push(']');
    userContent = userContent + parts.join('');
  }

  const messages = [
    ...previousMessages.map((m) => toClaudeMessage(m.role, m.content)),
    { role: 'user', content: userContent },
  ];

  const maxRounds = 15;
  let currentMessages = [...messages];
  let lastOrderToolResult = null;
  const ORDER_TOOL_PATTERN = /place_order|place_instamart_order|book_table|checkout|confirm_order|place_food_order/i;

  /** Recursively search object for order/booking IDs and success indicators.
   * CRITICAL: Swiggy MCP may return root success:true + message:"Order placed!" while data.successful:false.
   * We MUST prioritize data.successful and data.statusMessage over root-level fields. */
  function parseOrderSuccess(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;

    // Prioritize granular data.successful—definitive indicator of actual order placement
    const dataSuccessful = parsed?.data?.successful;
    if (dataSuccessful === false) return false;
    const statusMsg = String(parsed?.data?.statusMessage ?? '');
    if (statusMsg && /error|fail|unable|couldn't|invalid|not accepting/i.test(statusMsg)) return false;

    const hasError = parsed?.error || /fail|error|unable|couldn't|invalid/i.test(String(parsed?.message ?? parsed?.error_message ?? parsed?.error ?? ''));
    if (hasError) return false;

    const idFields = ['order_id', 'orderId', 'booking_id', 'bookingId', 'order_number', 'tracking_id', 'id'];
    const check = (obj, depth = 0) => {
      if (!obj || depth > 5) return false;
      for (const k of idFields) {
        const v = obj[k];
        if (v != null && (typeof v === 'string' ? v.length > 0 : true)) return true;
      }
      if (/placed|confirmed|success|complete/i.test(String(obj?.status ?? obj?.state ?? ''))) return true;
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object' && check(v, depth + 1)) return true;
      }
      return false;
    };
    return check(parsed);
  }

  /** Check plain text result for success indicators (when JSON parse fails) */
  function parseOrderSuccessFromText(str) {
    if (!str || typeof str !== 'string') return false;
    if (/Error:|error|failed|unable|couldn't|invalid/i.test(str.slice(0, 200))) return false;
    return /order.?id|order.?placed|placed|success|confirmed|order.?confirmed|booking.?confirmed/i.test(str);
  }

  log.step('Claude thinking...');

  for (let round = 0; round < maxRounds; round++) {
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

    if (response.stop_reason === 'end_turn' && text) {
      // Override when response claims order/booking success but: order tool was never called, or was called and failed
      const claimsSuccess = /\b(order|booking).*(placed|confirmed|successful)|successfully.*(placed|ordered|booked)|order\s+placed|booking\s+confirmed|order\s+id|order\s+#|orderid/i.test(text);
      const orderActuallySucceeded = lastOrderToolResult?.success;
      if (claimsSuccess && !orderActuallySucceeded) {
        log.claudeErr('Order tool failed or was not called — overriding response');
        const errContent = lastOrderToolResult?.content || '';
        let userMsg = "I wasn't able to complete the order. The request didn't go through.";
        try {
          const parsed = typeof errContent === 'string' ? JSON.parse(errContent) : errContent;
          // Prefer data.statusMessage (Swiggy's actual error) over root message (often misleading)
          const msg =
            parsed?.data?.statusMessage ??
            parsed?.message ??
            parsed?.error_message ??
            parsed?.error ??
            parsed?.details;
          if (msg && typeof msg === 'string' && msg.length < 300) {
            userMsg = `I couldn't complete the order. ${msg}`;
          } else if (errContent.startsWith('Error:')) {
            userMsg = `I couldn't complete the order. ${errContent.slice(0, 300)}`;
          }
        } catch {
          if (errContent.startsWith('Error:')) {
            userMsg = `I couldn't complete the order. ${errContent.slice(0, 300)}`;
          }
        }
        if (lastOrderToolResult?.content) {
          userMsg += "\n\nPlease check your delivery address and try again, or contact Swiggy support if the issue persists.";
        } else {
          userMsg = "I wasn't able to complete the order. The order tool wasn't called—please add items to your cart first, then try placing the order again. Check the logs for details.";
        }
        return {
          text: userMsg,
          stopReason: 'end_turn',
          usage: response.usage,
        };
      }
      return { text, stopReason: 'end_turn', usage: response.usage };
    }

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
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

    if (round > 0) log.step('Claude thinking...');
    const toolResults = [];
    for (const use of toolUses) {
      let input = { ...(use.input || {}) };
      // Augment place_order / place_food_order with session state when Claude omits required params
      if (ORDER_TOOL_PATTERN.test(use.name)) {
        const orig = { ...input };
        if (ctx.addressId && (input.addressId == null || input.address_id == null)) input.addressId = ctx.addressId;
        if (ctx.restaurantId && (input.restaurantId == null || input.restaurant_id == null)) input.restaurantId = ctx.restaurantId;
        if (ctx.cartId && (input.cartId == null && input.cart_id == null)) input.cartId = ctx.cartId;
      }
      let content;
      let toolSucceeded = false;
      try {
        log.tool(use.name);
        const result = await callTool(use.name, input, swiggyAuthToken);
        content = typeof result === 'string' ? result : JSON.stringify(result);
        toolSucceeded = !content.startsWith('Error:');
        // Check if this is an order/booking tool and whether result indicates success
        const isOrderTool = ORDER_TOOL_PATTERN.test(use.name);
        if (isOrderTool) {
          lastOrderToolResult = { toolName: use.name, success: false, content };
          if (toolSucceeded) {
            const str = typeof result === 'string' ? result : JSON.stringify(result);
            try {
              const parsed = typeof result === 'string' ? JSON.parse(result) : result;
              lastOrderToolResult.success = parseOrderSuccess(parsed);
            } catch {
              lastOrderToolResult.success = parseOrderSuccessFromText(str);
            }
          }
        }
      } catch (err) {
        content = `Error: ${err?.message || String(err)}`;
        log.tool(use.name, 'fail');
        log.claudeErr(err?.message || String(err));
        if (ORDER_TOOL_PATTERN.test(use.name)) {
          lastOrderToolResult = { toolName: use.name, success: false, content };
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content,
      });

      // Update session state from tool results to avoid redundant calls
      try {
        const parsed = typeof content === 'string' ? JSON.parse(content) : content;
        const name = use.name || '';
        const inp = input;
        if (name.includes('get_addresses') && parsed?.data?.addresses) {
          ctx.addresses = parsed.data.addresses.map((a) => ({ id: a.id, addressLine: (a.addressLine || '').slice(0, 80) }));
          if (ctx.addresses.length > 0 && !ctx.addressId) ctx.addressId = ctx.addresses[0].id;
        }
        if (name.includes('search_restaurants') && (parsed?.restaurants || parsed?.data?.restaurants)) {
          const list = parsed.restaurants || parsed.data?.restaurants || [];
          ctx.restaurants = list.slice(0, 20).map((r) => ({ id: String(r.id), name: r.name }));
        }
        if (name.includes('get_restaurant_menu') && (inp.restaurantId || inp.addressId)) {
          if (inp.restaurantId) ctx.restaurantId = String(inp.restaurantId);
          if (inp.addressId) ctx.addressId = String(inp.addressId);
        }
        if (name.includes('update_food_cart')) {
          if (inp.restaurantId) ctx.restaurantId = String(inp.restaurantId);
          if (inp.addressId) ctx.addressId = String(inp.addressId);
          const cartId = parsed?.data?.data?.cart_id ?? parsed?.data?.cart_id ?? parsed?.cart_id;
          if (cartId != null) ctx.cartId = String(cartId);
        }
      } catch (_) {}
    }

    currentMessages.push({
      role: 'user',
      content: toolResults,
    });
  }

  log.claudeErr('Max rounds reached');

  const limitMsg = "I hit the reply limit. Please try a shorter request or ask again.";
  return {
    text: limitMsg,
    stopReason: 'end_turn',
    usage: null,
  };
}
