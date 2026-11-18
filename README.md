# limecraft-bot

Mineflayer bot code for the Limecraft lab server. The sibling repo
`limecraft-infra` holds the docker-compose and other deployment files.

## Layout

- `packages/bot/`: Lime's own harness. One login (`Lime`) that acts, sees and
  chats. TypeScript, run directly by Node's native type stripping.
  - REST endpoints for curl debugging: `/state`, `/blocks?radius=`, `/events?after=`,
    `/snapshot?dx&dy&dz`, and `POST /chat|/look|/goto|/dig|/place|/equip|/stop`.
  - **MCP over Streamable HTTP** at `/mcp`: `get_state`, `get_blocks`, `find_blocks`,
    `find_entity`, `chat`, `read_events`, `look`, `goto`, `dig`, `place`, `equip`,
    `stop`, `snapshot`.
  - Embedded prismarine-viewer + headless Chromium for snapshots. The viewer
    client bundle is patched at startup so the camera follows the bot
    (`CAM_OFF_X/Y/Z` env controls the offset).
- `packages/cam/`: LimeCam spectator camera (earlier design). Serves the
  prismarine-viewer web view and `GET /snapshot`. Superseded by `packages/bot`;
  kept until the merged harness reaches parity in the lab.

## Notes

- Lab server runs 1.21.4 (prismarine-viewer's best-supported version).
- Bot logins are offline-mode accounts; offline UUID = md5("OfflinePlayer:<name>").
- Type gate: `npm run build` (runs `tsc --noEmit` in each workspace).
- zod must stay v4+ in `packages/bot`, see AGENTS.md.
- Field manual / operational lessons: Eyrie `processes/minecraft-bot-lessons.md`.
