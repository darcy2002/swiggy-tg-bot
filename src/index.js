/**
 * Swiggy Telegram Bot — place orders via natural language using Claude + Swiggy MCP.
 * @see https://github.com/Swiggy/swiggy-mcp-server-manifest
 */

import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import { chatWithClaudeMcp, clearCaches } from './claude-mcp.js';
import { getSwiggyTokenFromCursorMcp } from './cursor-mcp-token.js';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

/** Get current Swiggy token (reads .env at call time for /refresh support). */
function getSwiggyAuth() {
  return process.env.SWIGGY_AUTH_TOKEN || getSwiggyTokenFromCursorMcp() || undefined;
}

if (!TELEGRAM_TOKEN || !ANTHROPIC_KEY) {
  console.error(
    'Missing required env: TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY. Copy .env.example to .env and fill values.'
  );
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const SEP = '─'.repeat(50);
const log = {
  tg: (msg, ...args) => console.log(`\x1b[36m[TG]\x1b[0m ${msg}`, ...args),
  tgErr: (msg, ...args) => console.error(`\x1b[31m[TG]\x1b[0m ${msg}`, ...args),
  header: (text) => console.log(`\n\x1b[1m\x1b[35m${SEP}\n  📱 ${text}\n${SEP}\x1b[0m`),
  done: (text) => console.log(`\x1b[32m  ✓ ${text}\x1b[0m\n`),
};

// Keep last N turns (user + assistant pairs) for context
const MAX_TURNS = 5;
const chatHistory = new Map();

// Session state per chat: addressId, restaurantId, cartId from tool results
// Avoids re-calling get_addresses, search_restaurants on every message
const sessionState = new Map();

function getSessionState(chatId) {
  let s = sessionState.get(chatId);
  if (!s) {
    s = { addressId: null, restaurantId: null, cartId: null, restaurants: [], addresses: [] };
    sessionState.set(chatId, s);
  }
  return s;
}

function getHistory(chatId) {
  const history = chatHistory.get(chatId) || [];
  if (MAX_TURNS <= 0) return [];
  // Each turn = 2 messages (user + assistant)
  return history.slice(-MAX_TURNS * 2);
}

/** Strip HTML tags for plain-text fallback when parse fails */
function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function pushHistory(chatId, role, content) {
  if (MAX_TURNS <= 0) return;
  let history = chatHistory.get(chatId) || [];
  history.push({ role, content });
  const maxLen = MAX_TURNS * 2;
  if (history.length > maxLen) history = history.slice(-maxLen);
  chatHistory.set(chatId, history);
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  // /start
  if (text === '/start') {
    await bot.sendMessage(
      chatId,
      `<b>Hi! I'm your Swiggy assistant.</b> You can:\n\n` +
        `• <b>Order food</b> — e.g. "Find biryani near me and add one to cart"\n` +
        `• <b>Order groceries</b> — e.g. "Add milk and bread to my Instamart cart for home delivery"\n` +
        `• <b>Book tables</b> — e.g. "Book a table for 2 at an Italian place in Koramangala tomorrow at 8 PM"\n\n` +
        `<i>Tip:</i> Say your delivery address (e.g. "use my home address") for faster ordering. Use /clear to start fresh. COD only; orders can't be cancelled once placed.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // /help
  if (text === '/help') {
    await bot.sendMessage(
      chatId,
      'Just type what you want in plain language, e.g.:\n\n' +
        '• "Order chicken biryani from a good restaurant"\n' +
        '• "Add Maggi and eggs to my Instamart cart"\n' +
        '• "Book a table for 4 at a North Indian restaurant this Saturday 7 PM"',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // /refresh — reload .env and clear caches (use after updating SWIGGY_AUTH_TOKEN)
  if (text === '/refresh') {
    dotenv.config();
    clearCaches();
    await bot.sendMessage(chatId, '<b>Caches cleared.</b> New token loaded from .env. Try your request again.', { parse_mode: 'HTML' });
    return;
  }

  // /clear — reset session state (new search, new address, fresh start)
  if (text === '/clear') {
    sessionState.delete(chatId);
    await bot.sendMessage(chatId, '<b>Session cleared.</b> Starting fresh—you can search again.', { parse_mode: 'HTML' });
    return;
  }

  log.header(`NEW REQUEST — "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);

  const loadingMsg = await bot.sendMessage(chatId, 'Checking Swiggy…');

  try {
    const previousMessages = getHistory(chatId).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    log.tg('Sending to Claude...');
    const state = getSessionState(chatId);
    const { text: reply, usage } = await chatWithClaudeMcp({
      userMessage: text,
      swiggyAuthToken: getSwiggyAuth(),
      previousMessages,
      sessionState: state,
    });

    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const formattedReply = reply || 'Done.';
    try {
      await bot.sendMessage(chatId, formattedReply, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (parseErr) {
      // Fallback to plain text if HTML parsing fails (e.g. invalid/unclosed tags)
      const errMsg = parseErr?.message || parseErr?.response?.body?.description || '';
      if (errMsg.includes("Can't parse") || errMsg.includes('parse entities') || errMsg.includes('Bad Request')) {
        log.tg('HTML parse failed, sending as plain text');
        await bot.sendMessage(chatId, stripHtml(formattedReply), {
          parse_mode: undefined,
          disable_web_page_preview: true,
        });
      } else {
        throw parseErr;
      }
    }

    log.done(`Response sent (${(reply || '').length} chars)`);
    if (usage) log.tg(`Tokens: ${(usage.input_tokens || 0) + (usage.output_tokens || 0)} total`);
    // Store only plain text in history (user message + assistant reply)
    pushHistory(chatId, 'user', text);
    pushHistory(chatId, 'assistant', reply || 'Done.');
  } catch (err) {
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const message =
      err?.message || err?.toString?.() || 'Something went wrong.';
    log.tgErr('request failed', { chatId, error: message });
    console.error('[TG] Claude/MCP error:', err);
    await bot.sendMessage(
      chatId,
      `Error: ${message}. Check ANTHROPIC_API_KEY and that Swiggy MCP is reachable.`
    );
  }
});

bot.on('polling_error', (err) => {
  console.error('Telegram polling error:', err.message || err);
});

console.log('\n\x1b[1m\x1b[32mSwiggy Telegram bot is running.\x1b[0m Send a message in Telegram to try it.\n');
