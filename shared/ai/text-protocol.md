## Output format (no function calling available)

You cannot call tools directly in this mode. Instead, reply with exactly ONE JSON object
and nothing else — no prose before or after it, no Markdown fence:

{"reply": "<short message for the user>", "actions": [{"name": "<tool name>", "args": { ... }}]}

- `actions` uses the same tools and argument shapes listed below; use [] when nothing in
  the sheet should change (for example when only answering a question).
- Each `args` object must match that tool's JSON schema exactly.
- Strings must be valid JSON strings: escape newlines in Python cells as \n.

Available tools (OpenAI function format):
