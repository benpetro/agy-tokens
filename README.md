# AGY Tokens

Live Gemini token usage, cache hit rate, 5-hour quota pro-rating, and a 7-day multi-conversation comparison dashboard for [Google Antigravity](https://antigravity.google).

## Features

- **This Conversation**
  - **Total Tokens**, **Input Tokens** (uncached vs. cached), **Output Tokens**, and **Latest Context** window size.
  - **Est. 5hr Quota** pro-rated from Antigravity's live `GetUserStatus` 5-hour window.
  - **Cache Hit Rate** percentage and progress bar.
  - **Turn Breakdown** grouped by user message (prompt text, new input, cached, output, tool count, timestamp).
  - **View Conversation** button to jump directly to any selected conversation.
- **Dashboard (7d)**
  - **5hr Quota Left** with live reset countdown.
  - **7-Day Total Burn** across recent conversations.
  - **Sortable Comparison Table** (`Conversation`, `Updated`, `Tokens`, `Cache`, `7d Share`, `Est. 5hr`) with workspace labels and one-click **View** / inspect actions.
- **Theme-Adaptive UI:** Uses Antigravity's native theme variables (`--background`, `--foreground`, `--muted-foreground`, `--secondary-foreground`) for both light and dark modes.

## Installation

### Ask Antigravity (Recommended)

Open a new conversation in Antigravity and ask:

> Install the plugin from https://github.com/benpetro/agy-tokens

### From Antigravity CLI

```bash
agy plugin install https://github.com/benpetro/agy-tokens
```

### Manual (`plugins.json`)

1. Clone this repository:
   ```bash
   git clone https://github.com/benpetro/agy-tokens.git ~/Code/agy-tokens
   ```
2. Register it in `~/.gemini/config/plugins.json`:
   ```json
   {
     "entries": [
       {
         "path": "/Users/<your-username>/Code",
         "include_only": ["agy-tokens"]
       }
     ]
   }
   ```
3. Open the **Tokens** panel in the right-hand auxiliary pane.

## How It Works

- Runs as a read-only Node.js sidecar (`sidecars/panel/main.mjs`) using `sidecar_sdk`.
- Reads local conversation transcripts from `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
- Queries the local Antigravity Language Server (`GetUserStatus` and `GetAllCascadeTrajectories`) for live 5-hour quota remaining, conversation titles, and workspace names.
- All data stays local on your machine.

## Development & Testing

```bash
node --test sidecars/panel/token-service.test.mjs
```
