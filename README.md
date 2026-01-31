# Swiggy Telegram Bot

Place Swiggy orders from natural language in Telegram using **Claude** and the **Swiggy MCP** (Model Context Protocol).

- **Swiggy Food** — search restaurants, browse menus, manage cart, place food orders (COD)
- **Instamart** — search products, cart, place grocery orders (COD)
- **Dineout** — discover restaurants, check slots, book tables (free bookings)

## Prerequisites

- Node.js 18+
- [Telegram Bot Token](https://core.telegram.org/bots#botfather) from @BotFather
- [Anthropic API key](https://console.anthropic.com/)
- (Optional) Swiggy OAuth token for placing orders — see [Swiggy MCP manifest](https://github.com/Swiggy/swiggy-mcp-server-manifest)

## Setup

1. **Clone and install**

   ```bash
   cd swiggy-tg-bot
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:

   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `ANTHROPIC_API_KEY` — from Anthropic console
   - `SWIGGY_AUTH_TOKEN` — optional; required for placing orders. Obtain via [MCP Inspector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector#obtaining-an-access-token-for-testing):
     - Run `npx @modelcontextprotocol/inspector`
     - Transport: SSE or Streamable HTTP, URL e.g. `https://mcp.swiggy.com/food`
     - Open Auth Settings → Quick OAuth Flow → copy `access_token` into `SWIGGY_AUTH_TOKEN`

3. **Run the bot**

   ```bash
   npm start
   ```

   Or with auto-restart: `npm run dev`

## Usage

- **/start** — Intro and tips  
- **/help** — Example prompts  
- Or just type in natural language, e.g.:
  - *"Find biryani restaurants near me and add one to cart"*
  - *"Add milk and bread to my Instamart cart for home delivery"*
  - *"Book a table for 2 at an Italian place in Koramangala tomorrow 8 PM"*

**Tips:** Mention your delivery address (e.g. "use my home address"). Orders are COD only and cannot be cancelled once placed. Do not use the Swiggy app at the same time to avoid session issues.

## How it works

1. You send a message in **Telegram**.
2. The message goes to **Claude** (Anthropic Messages API) with Swiggy MCP tool definitions (Food, Instamart, Dineout).
3. Claude interprets the user’s intent, calls the right MCP tools (search, cart, order, etc.), and replies in Telegram.

So: **Telegram → Claude (chooses tools) → we call Swiggy MCP → results → Claude (formats reply) → Telegram.** Your **Swiggy OAuth token** is used only when calling the MCP server (step 4).

## Troubleshooting: OAuth token ("Failed to discover OAuth metadata")

If MCP Inspector (or another OAuth client) shows **"Failed to discover OAuth metadata"** when you use the Swiggy MCP URL (`https://mcp.swiggy.com/food`), it’s because:

- OAuth discovery is exposed at the **domain root**, not under `/food`.
- Valid discovery URL: `https://mcp.swiggy.com/.well-known/oauth-authorization-server`
- Many clients derive discovery from the MCP URL (e.g. `.../food/.well-known/...`), which Swiggy does not serve, so discovery fails.

**Ways to get a token:**

1. **Guided OAuth Flow (recommended)**  
   In MCP Inspector (or your client), use **"Guided OAuth Flow"** instead of "Quick OAuth Flow" and set:
   - **Discovery / Authorization server:** `https://mcp.swiggy.com/.well-known/oauth-authorization-server`  
     **or** manually:
   - **Authorization URL:** `https://mcp.swiggy.com/auth/authorize`
   - **Token URL:** `https://mcp.swiggy.com/auth/token`
   - Redirect URI: one of the [whitelisted URIs](https://github.com/Swiggy/swiggy-mcp-server-manifest#supported-oauth-redirect-uris) (e.g. `http://localhost/callback`).  
   If the tool asks for a custom discovery URL, use the discovery URL above.

2. **Use a supported client first**  
   Swiggy supports **Claude Desktop, Cursor, VS Code, Raycast, Kiro**. Add the Swiggy MCP in one of these (e.g. Cursor or Claude Desktop), complete OAuth there, then use the bot; the token is managed by that client. For a standalone bot you’d still need a token (e.g. via Guided OAuth above).

3. **Run without a token**  
   You can leave `SWIGGY_AUTH_TOKEN` unset. Search, menu browsing, and similar read-only flows may work without auth; placing orders or updating cart for your account usually requires a token. You can try the bot without a token and add one later.

4. **Ask Swiggy**  
   For more options (e.g. extra redirect URIs or headless token flow), contact the [Swiggy developer team](https://github.com/Swiggy/swiggy-mcp-server-manifest).

## Using the token from Cursor (mcp.json)

**Cursor does not store Swiggy OAuth tokens in a readable place.** Your `~/.cursor/mcp.json` has `swiggy-food` with `"headers": {}` — Cursor either doesn’t complete OAuth for Swiggy or keeps the token in the system keychain and doesn’t write it to the config. So you **cannot** “fetch” the token from Cursor automatically.

If you obtain a token (e.g. via **Guided OAuth** in MCP Inspector with discovery URL `https://mcp.swiggy.com/.well-known/oauth-authorization-server`), you can:

1. **Put it in `.env`**  
   `SWIGGY_AUTH_TOKEN=your_token_here`

2. **Or put it in Cursor’s mcp.json** (one place for Cursor + this bot):  
   Edit `~/.cursor/mcp.json` and add the token under `swiggy-food` (or `swiggy-instamart` / `swiggy-dineout`):

   ```json
   "swiggy-food": {
     "type": "http",
     "url": "https://mcp.swiggy.com/food",
     "headers": { "Authorization": "Bearer YOUR_ACCESS_TOKEN" }
   }
   ```

   The bot will use `SWIGGY_AUTH_TOKEN` from env first; if that’s not set, it will read the token from `~/.cursor/mcp.json` for any of the Swiggy MCP entries.

## References

- [Swiggy MCP Server Manifest](https://github.com/Swiggy/swiggy-mcp-server-manifest)
- [Claude MCP Connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
