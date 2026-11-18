# Token Tracker (`agy-tokens`)

Live Gemini token usage, cache hit rate, 5-hour quota pro-rating, A–D efficiency grading, and a 7-day multi-conversation comparison dashboard for [Google Antigravity](https://antigravity.google).

## Features

- **This Conversation**
  - **Clickable Title & External Link:** Displays the active conversation title with a link to jump directly to the conversation.
  - **A–D Efficiency Rating:** Color-coded `Rating: A/B/C/D` badge with hover tooltip explaining the 0–100 score (work per uncached token, cache hit rate, error-free steps, and context bloat penalty) plus actionable prompting advice.
  - **Total Tokens** (including subagent rollup), **Input Tokens** (uncached vs. cached), **Output Tokens**, and **Latest Context** window size.
  - **Est. 5hr Quota** pro-rated from Antigravity's live `GetUserStatus` 5-hour window.
  - **Cache Hit Rate** percentage and progress bar.
  - **Turn Breakdown** grouped by user message (`Message`, `Model`, `New In`, `Cached`, `Output`, `Tools`, `Time`).
  - **Rotating Tips:** Clickable tip banner explaining cached tokens, new vs. output tokens, tools count, and the A–D rating.
- **Dashboard (7d)**
  - **5hr Quota Left** with live reset countdown.
  - **7-Day Total Burn** across recent conversations (with child subagent usage rolled into parent conversations).
  - **Sortable Comparison Table** (`Conversation`, `Rating`, `Updated`, `Tokens`, `Cache`, `7d Share`, `Est. 5hr`) with workspace labels, subagent counts, and one-click **View** / inspect actions.
- **Always-On Live Updates:** Automatically polls every 10 seconds and adapts to Antigravity's light and dark themes.

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
3. Open the **Token Tracker** panel in the right-hand auxiliary pane.

## How It Works

- Runs as a read-only Node.js sidecar (`sidecars/panel/main.mjs`) using `sidecar_sdk`.
- Reads local conversation transcripts (and rolls up child subagent transcripts) from `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
- Queries the local Antigravity Language Server (`GetUserStatus`, `GetAllCascadeTrajectories`, and `GetCascadeTrajectorySteps`) for live 5-hour quota remaining, conversation titles, workspace names, and per-step model labels.
- All data stays local on your machine.

## Development & Testing

```bash
node --test sidecars/panel/token-service.test.mjs
```
