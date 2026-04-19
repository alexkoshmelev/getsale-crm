---
name: docs
description: Skill for understanding project documentation structure. Apply when user asks about documentation or needs to see how docs are organized.
disable-model-invocation: false
---

# Documentation Structure Skill

## Configuration-Based Documentation

**IMPORTANT:** Documentation paths are configured in `.cursor/config.json`. Never hardcode paths.

### Reading Configuration

Always read documentation paths from config:

```javascript
config = readJSON(".cursor/config.json")
paths = config.documentation.paths

// paths.root = "docs"
// paths.architecture = "docs/architecture"
// paths.api = "docs/api"
// paths.features = "docs/domain"
// etc.
```

## Documentation Structure

All documentation lives in `docs/` with subdirectories by category:

```
docs/
├── INDEX.md                    # Navigation hub (start here)
├── ROADMAP.md                  # Priorities and backlog
│
├── architecture/               # System design and boundaries
│   ├── ARCHITECTURE.md        # Main architecture document
│   ├── TABLE_OWNERSHIP.md    # Data ownership between services
│   ├── SHARED_BUILD_ORDER.md # Monorepo build order
│   └── STAGES.md             # Development stages
│
├── api/                        # API contracts
│   ├── CRM_API.md
│   ├── INTERNAL_API.md
│   ├── SERVICE_HTTP_CLIENT_INVENTORY.md
│   └── EVENT_HANDLER_POLICY.md
│
├── domain/                     # Business domain flows
│   ├── MESSAGING_ARCHITECTURE.md
│   ├── TELEGRAM_MESSAGING_FLOW.md
│   ├── TELEGRAM_API_ANALYSIS.md
│   ├── CAMPAIGNS.md
│   ├── CAMPAIGN_FLOW_AND_LOGS.md
│   ├── CAMPAIGN_AI.md
│   ├── TELEGRAM_PARSE_FLOW.md
│   └── OUTREACH_BEST_PRACTICES.md
│
├── product/                    # Product strategy
│   ├── MASTER_PLAN.md
│   └── COMPETITOR_ANALYSIS.md
│
├── operations/                 # Infrastructure and setup
│   ├── DEPLOYMENT.md
│   ├── GETTING_STARTED.md
│   ├── TESTING.md
│   └── MIGRATIONS.md
│
├── runbooks/                   # Operational runbooks
│   ├── ORPHAN_MESSAGES.md
│   └── BD_ACCOUNTS_TIMEOUT.md
│
└── adr/                        # Architecture Decision Records
    └── README.md
```

## Directory Purpose

**architecture/** - System design, service boundaries, data ownership
**api/** - API endpoints, inter-service contracts, HTTP client inventory
**domain/** - Business flows: messaging, campaigns, Telegram, parsing
**product/** - Product strategy, competitor analysis, master plan
**operations/** - Deployment, getting started, testing, DB migrations
**runbooks/** - Operational procedures for specific incidents
**adr/** - Architecture Decision Records

## When to Update Documentation

### Automatically (when orchestration completes)
- After feature implementation
- After bug fixes
- After architecture decisions

### Manually (when user requests)
- `/documenter update docs for [feature]`
- User asks "update documentation"
- User asks "document this change"

## How to Read Documentation

Start with `docs/INDEX.md` for the full navigation. To include specific docs:

```
@docs/architecture/ARCHITECTURE.md
@docs/api/CRM_API.md
@docs/ROADMAP.md
```

To see all documentation:
```
@docs
```

## Documentation Guidelines

1. **One topic per file** - Don't mix concerns
2. **Always date updates** - Include timestamps
3. **Link to code** - Reference actual files
4. **Keep it current** - Archive old/completed items
5. **Use markdown** - Standard formatting
6. **Cross-reference** - Link related docs using relative paths

## File Naming

- All-caps with underscores: `ARCHITECTURE.md`, `CRM_API.md`
- Consistent with existing conventions in the directory

## Architecture Decision Records (ADR)

- **Canonical location:** `docs/adr/`
- New ADRs: numbered file `NNNN-kebab-case-title.md`
- Supplementary architecture notes in `docs/architecture/`

## Configuration Example

Example `.cursor/config.json`:

```json
{
  "documentation": {
    "paths": {
      "root": "docs",
      "architecture": "docs/architecture",
      "api": "docs/api",
      "features": "docs/domain",
      "plans": "docs/product",
      "operations": "docs/operations",
      "runbooks": "docs/runbooks"
    },
    "enabled": {
      "architecture": true,
      "api": true,
      "features": true,
      "plans": true,
      "operations": true,
      "runbooks": true
    }
  }
}
```
