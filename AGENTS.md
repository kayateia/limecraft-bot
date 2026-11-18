## Overview

This project is a monorepo for Minecraft-related LLM MCP tools.

Full information about [pi.dev plugins and practices](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

## Needed files

All needed files are located in this project directory and `~/.pi`. Don't go searching for other files elsewhere. Don't use `find $HOME` or similar tactics.

## Code standards

- Use 2-space indents
- Write comments anywhere they could assist in understanding, especially on methods/functions and classes.
- Do not use `any` or other typecheck defeating primitives

Use the following copyright header in new files:

```
/**
 * limecraft-bot
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */
```

## Source control

Use git, rooted in the project directory (here). Commit early and often with conventional commits.

Avoid stacked or cross-dependent pull requests. Create each PR independently
from `main` unless a concrete compile, test, or runtime dependency means one
change cannot function without another unmerged change. When such a dependency
is unavoidable, state the technical reason and required landing order in each
affected PR, and make a GitHub stack.

## Building

`npm run build` is the primary build process (it runs `npm run typecheck` in each workspace).

Dependencies live at the repo root (`npm install`, npm workspaces). Containers map the whole
checkout at `/repo` and use those host-installed dependencies; do not add per-package
`node_modules` mounts or bake code into images.

`packages/bot` runs TypeScript directly on Node's native type stripping (`node src/index.ts`);
`tsc --noEmit` is the type gate. Avoid syntax the stripper rejects: no `enum`, no `namespace`,
and no constructor parameter properties.

zod must stay at v4+ in `packages/bot`. With zod 3.25, `McpServer.registerTool` type inference
explodes (`TS2589: Type instantiation is excessively deep and possibly infinite`), and the
compiler takes minutes before reporting it.

## Testing

Use jest for unit tests.

