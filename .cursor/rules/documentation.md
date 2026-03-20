---
description: Documentation requirements for code and functions
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# Documentation Standards

## When to Document (JSDoc)

**Always document:**

- Public APIs
- Complex algorithms
- Non-obvious business logic
- Workarounds and hacks (with TODO to fix)

**Skip documentation for:**

- Self-explanatory code
- Private helper functions
- Simple CRUD operations
- Getters/setters

## Format

```typescript
/**
 * Authenticates user with email and password.
 * 
 * @param email - User's email address
 * @param password - Plain text password
 * @returns User object with session token
 * @throws {AuthError} If credentials are invalid
 */
async function login(email: string, password: string): Promise<AuthResult> {
  // ...
}
```

## When to Use Docs Skill

**Use `.cursor/skills/docs/SKILL.md` when:**

- User asks to update or create documentation
- After implementing a feature
- Need to understand project documentation structure (configured in `.cursor/config.json`)
- User mentions documentation, docs, or asks "document this"

## Architecture Decision Records (ADR)

- **Canonical location:** `docs/adr/` — see [docs/adr/README.md](../../docs/adr/README.md).
- New ADRs: numbered file `NNNN-kebab-case-title.md`; optional one-line entry in the README table there.
- Do not duplicate full ADR text under `ai_docs/`; link from ADR to supplementary notes in `ai_docs/develop/architecture/` if needed.
- Human-facing contributor entry: [CONTRIBUTING.md](../../CONTRIBUTING.md).
