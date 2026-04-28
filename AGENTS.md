# Agent Teams Lite - Repository Instructions

This file contains high-signal context and conventions for AI agents working in this repository.

## Stack & Architecture

- **Language/Runtime:** TypeScript, Node.js.
- **Key Libraries:** `node-telegram-bot-api`, `axios`, `dotenv`.
- **Architecture:** Local Telegram bot using long polling. Relays text messages to an OpenCode HTTP endpoint.
- **Mocking:** Includes a local mock backend (`mock/opencode-mock.ts`) to simulate the OpenCode API.

## Developer Workflow & Commands

Do not guess commands. Use these exact scripts:

- `npm install` - Install dependencies.
- `npm run dev` - Runs the Telegram bot in isolation (`src/index.ts`).
- `npm run mock` - Runs the OpenCode mock backend on `http://localhost:3000`.
- `npm run start:local` - **Primary dev command.** Runs both the bot and the mock concurrently. It creates a `.local-runtime.json` lockfile to prevent duplicate instances.
- `npm run stop:local` - Kills orphaned processes tracked in `.local-runtime.json`. Use this if `start:local` complains about an existing instance.

## Known Quirks & Gotchas

- **IPv4 Enforcement:** The Telegram bot client forces IPv4 resolution to prevent `EFATAL: AggregateError` on systems where IPv6 routing to Telegram fails. Do not remove this workaround in `src/index.ts`.
- **Process Management:** The `start-local.js` and `stop-local.js` scripts manage PIDs manually via `.local-runtime.json`. If modifying dev scripts, ensure PID tracking remains intact.
- **Language:** The bot is strictly hardcoded to Spanish (`"es"`) for v1 responses.
- **API Flow:** The bot uses a simple POST request with a Bearer token (`OPEN_CODE_TOKEN`) to the `OPEN_CODE_URL` with 1 short retry on 5xx/timeout errors.

## Testing & Verification

- There are no formal unit tests (e.g., Jest/Mocha). Verification is done manually by running `npm run start:local` and interacting with the bot on Telegram.

# # Strong style override

CAVEMAN MODE REQUIRED.  
Every answer must be short, blunt, technical.  
No greetings. No jokes. No metaphors. No "hermano". No filler.  
Avoid long examples unless user asks.  
Prefer fragments over paragraphs.  
Max 6 short lines for explanations by default.  
If user asks code, code normal. Explanation caveman.  
EOF

# GSAP skills

When the task involves GSAP, animations, React animations, ScrollTrigger, timelines, performance, or GSAP plugins, use the relevant gsap-* skills before answering or editing code.
Prefer gsap-react for React projects, gsap-scrolltrigger for scroll animations, gsap-timeline for sequencing, gsap-performance for optimization, and gsap-plugins when plugins are mentioned.

## RFC Closure Gate

- Un RFC NO se considera cerrado hasta actualizar `CHANGELOG.md` con referencia explícita al RFC (ej. `RFC-015`).
- La entrada puede ir en `## [Unreleased]` o en bloque versionado `## [x.y.z]`.
- Criterio de cierre: RFC en estado implementado + entrada en changelog presente.
