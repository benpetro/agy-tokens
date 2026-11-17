window.AGY_TOKEN_TIPS = [
  '<strong>Tip:</strong> <strong>Cached tokens</strong> are prompt tokens (system context, earlier messages, and tool outputs) reused from Gemini\'s context cache instead of being reprocessed from scratch. <strong>Cache hit rate</strong> is the share of total input served from cache (<code>cached / (new + cached)</code>)—higher means faster responses and lower quota burn.',
  '<strong>Tip:</strong> <strong>New In</strong> tokens are fresh uncached tokens sent to Gemini for that message (your prompt plus any uncached file reads, command outputs, or tool results). <strong>Output</strong> tokens are the tokens Gemini generated in its response (text, tool calls, and thinking).',
  '<strong>Tip:</strong> <strong>Tools</strong> is the number of tool calls (file reads, edits, searches, terminal commands, MCP calls, or subagents) Gemini executed while working on that message. More tool calls mean more round-trips and higher token usage.',
  '<strong>Tip:</strong> The <strong>A–D rating</strong> scores conversation efficiency (0–100) from work per uncached token (40%), cache hit rate (35%), error-free steps (25%), minus a bloat penalty for oversized contexts.',
];
