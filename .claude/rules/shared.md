---
paths:
  - "packages/shared/**"
---

# Shared package rules

- No Node or browser APIs, and no I/O. Only types, zod schemas and pure functions.
- Infer TypeScript types from zod schemas (`z.infer`); never define the same shape twice.
- Changing an existing schema is a contract change: ask first, and update both apps in the same branch.
- Pure functions here (reducers, parsers) need full branch coverage.
