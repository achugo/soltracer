---
paths:
  - "apps/web/**"
---

# Web rules

- Server components by default; add `"use client"` only where needed.
- The browser calls only this app's `app/api/*` routes. Those routes check the session and call the engine server-side with `ENGINE_TOKEN`.
- No env var reaches the client unless it starts with `NEXT_PUBLIC_`, and none of those may hold a key, token or RPC URL.
- Parse every engine response and SSE message with the shared zod schemas.
- Real `<button>`, `<a>` and labelled inputs. Icon-only buttons get `aria-label`. Controls at least 44 px.
- Status is shown by text or icon as well as color. Animations stop under `prefers-reduced-motion`.
