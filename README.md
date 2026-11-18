# limecraft-bot

Mineflayer bot code for the Limecraft lab server. Bot-uid files: JavaScript,
package manifests, Dockerfiles. The sibling repo `limecraft-infra` holds the
docker-compose and other root-owned deployment files.

## Layout

- `bot/`: Lime's own harness (Mineflayer + HTTP bridge, `/state`, `/blocks`,
  `/events` chat cursor, `/goto`, `/dig`, `/place`, ...). Parked prototype;
  planned to become the primary bot (act + see + chat, one account).
- `cam/`: LimeCam spectator camera. Serves prismarine-viewer's web 3D view and
  exposes `GET /snapshot` (PNG) via headless Chromium. Patches the
  prismarine-viewer client bundle at startup so the camera follows the bot
  (`CAM_OFF_X/Y/Z` env controls the offset).

## Notes

- Lab server runs vanilla 1.21.4 (prismarine-viewer's best-supported version).
- Bot logins are offline-mode accounts; offline UUID = md5("OfflinePlayer:<name>").
- Field manual / operational lessons: Eyrie `processes/minecraft-bot-lessons.md`.
