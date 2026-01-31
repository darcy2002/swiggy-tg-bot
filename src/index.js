/**
 * Swiggy Telegram Bot — place orders via natural language using Claude + Swiggy MCP.
 * @see https://github.com/Swiggy/swiggy-mcp-server-manifest
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { chatWithClaudeMcp } from './claude-mcp.js';
import { getSwiggyTokenFromCursorMcp } from './cursor-mcp-token.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// Prefer .env; fallback to Cursor mcp.json if you add the token there manually
const SWIGGY_AUTH =
  process.env.SWIGGY_AUTH_TOKEN || getSwiggyTokenFromCursorMcp() || undefined;

if (!TELEGRAM_TOKEN || !ANTHROPIC_KEY) {
  console.error(
    'Missing required env: TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY. Copy .env.example to .env and fill values.'
  );
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Optional: keep last N messages per chat for context (set to 0 to disable)
const MAX_HISTORY = 10;
const chatHistory = new Map();

function getHistory(chatId) {
  const history = chatHistory.get(chatId) || [];
  if (MAX_HISTORY <= 0) return [];
  return history.slice(-MAX_HISTORY * 2);
}

function pushHistory(chatId, role, content) {
  if (MAX_HISTORY <= 0) return;
  let history = chatHistory.get(chatId) || [];
  history.push({ role, content });
  const maxLen = MAX_HISTORY * 2;
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
      `Hi! I'm your Swiggy assistant. You can:\n\n` +
        `• Order food — e.g. "Find biryani near me and add one to cart"\n` +
        `• Order groceries — e.g. "Add milk and bread to my Instamart cart for home delivery"\n` +
        `• Book tables — e.g. "Book a table for 2 at an Italian place in Koramangala tomorrow at 8 PM"\n\n` +
        `Tip: Say your delivery address (e.g. "use my home address") for faster ordering. COD only; orders can't be cancelled once placed.`
    );
    return;
  }

  // /help
  if (text === '/help') {
    await bot.sendMessage(
      chatId,
      'Just type what you want in plain language, e.g.:\n' +
        '"Order chicken biryani from a good restaurant"\n' +
        '"Add Maggi and eggs to my Instamart cart"\n' +
        '"Book a table for 4 at a North Indian restaurant this Saturday 7 PM"'
    );
    return;
  }

  const loadingMsg = await bot.sendMessage(chatId, 'Checking Swiggy…');

  try {
    const previousMessages = getHistory(chatId).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const { text: reply } = await chatWithClaudeMcp({
      userMessage: text,
      swiggyAuthToken: SWIGGY_AUTH,
      previousMessages,
    });

    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const sent = await bot.sendMessage(chatId, reply || 'Done.', {
      parse_mode: undefined,
      disable_web_page_preview: true,
    });

    pushHistory(chatId, 'user', text);
    pushHistory(chatId, 'assistant', reply || 'Done.');
  } catch (err) {
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const message =
      err?.message || err?.toString?.() || 'Something went wrong.';
    await bot.sendMessage(
      chatId,
      `Error: ${message}. Check ANTHROPIC_API_KEY and that Swiggy MCP is reachable.`
    );
    console.error('Claude/MCP error:', err);
  }
});

bot.on('polling_error', (err) => {
  console.error('Telegram polling error:', err.message || err);
});

console.log('Swiggy Telegram bot is running. Send a message in Telegram to try it.');
