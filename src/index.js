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
