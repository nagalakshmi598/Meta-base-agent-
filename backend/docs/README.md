# Agent Documentation (RAG source)

Drop your CloudFuze product/how-to documentation here as `.md` or `.txt` files.
The assistant automatically indexes every file in this folder and uses it to
answer product/conceptual questions (e.g. "how does CloudFuze handle Slack
threads?") — separately from live database queries.

- Supported: `.md`, `.markdown`, `.txt`
- The agent answers **only** from these docs and cites the source file.
- After adding or editing docs, they're re-indexed on the next server start
  (or call `POST /api/ai/reload-docs`).
