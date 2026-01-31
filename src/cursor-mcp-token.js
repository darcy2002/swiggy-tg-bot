/**
 * Optional: read Swiggy MCP auth token from Cursor's mcp.json.
 * Cursor does NOT store OAuth tokens in mcp.json by default (headers are empty).
 * If you add the token manually to ~/.cursor/mcp.json under swiggy-food (or
 * swiggy-instamart / swiggy-dineout) headers.Authorization, this bot can use it.
 *
 * Example mcp.json entry:
 *   "swiggy-food": {
 *     "type": "http",
 *     "url": "https://mcp.swiggy.com/food",
 *     "headers": { "Authorization": "Bearer YOUR_ACCESS_TOKEN" }
 *   }
 *
 * @returns {string|undefined} Raw token (without "Bearer ") or undefined if not found.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const MCP_JSON_PATH = join(homedir(), '.cursor', 'mcp.json');
const SWIGGY_KEYS = ['swiggy-food', 'swiggy-instamart', 'swiggy-dineout'];

export function getSwiggyTokenFromCursorMcp() {
  try {
    const raw = readFileSync(MCP_JSON_PATH, 'utf8');
    const json = JSON.parse(raw);
    const servers = json?.mcpServers || {};
    for (const key of SWIGGY_KEYS) {
      const auth = servers[key]?.headers?.Authorization;
      if (auth && typeof auth === 'string') {
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        if (token) return token;
      }
    }
  } catch {
    // file missing, invalid JSON, or no token
  }
  return undefined;
}
