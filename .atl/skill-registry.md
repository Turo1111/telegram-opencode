# Skill Registry

**Delegator use only.** Resolve matching skills here, inject compact rules into sub-agent prompts.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| When writing TypeScript code - types, interfaces, generics. | typescript | /home/matias/.config/opencode/skills/typescript/SKILL.md |
| When styling with Tailwind - cn(), theme variables, no var() in className. | tailwind-4 | /home/matias/.config/opencode/skills/tailwind-4/SKILL.md |
| When writing React components - no useMemo/useCallback needed. | react-19 | /home/matias/.config/opencode/skills/react-19/SKILL.md |
| When working with Next.js - routing, Server Actions, data fetching. | nextjs-15 | /home/matias/.config/opencode/skills/nextjs-15/SKILL.md |
| When using Zod for validation - breaking changes from v3. | zod-4 | /home/matias/.config/opencode/skills/zod-4/SKILL.md |
| When managing React state with Zustand. | zustand-5 | /home/matias/.config/opencode/skills/zustand-5/SKILL.md |
| When writing Python tests - fixtures, mocking, markers. | pytest | /home/matias/.config/opencode/skills/pytest/SKILL.md |
| When writing E2E tests - Page Objects, selectors, MCP workflow. | playwright | /home/matias/.config/opencode/skills/playwright/SKILL.md |
| When building REST APIs with Django - ViewSets, Serializers, Filters. | django-drf | /home/matias/.config/opencode/skills/django-drf/SKILL.md |
| When writing Go tests, using teatest, or adding test coverage. | go-testing | /home/matias/.config/opencode/skills/go-testing/SKILL.md |
| When building AI chat features - breaking changes from v4. | ai-sdk-5 | /home/matias/.config/opencode/skills/ai-sdk-5/SKILL.md |
| Angular architecture patterns. | angular-architecture | /home/matias/.config/opencode/skills/angular/architecture/SKILL.md |
| Angular standalone/signals/control-flow patterns. | angular-core | /home/matias/.config/opencode/skills/angular/core/SKILL.md |
| Angular forms and validation. | angular-forms | /home/matias/.config/opencode/skills/angular/forms/SKILL.md |
| Angular performance, lazy loading, defer, images. | angular-performance | /home/matias/.config/opencode/skills/angular/performance/SKILL.md |
| GSAP base tweening API. | gsap-core | /home/matias/.config/opencode/skills/gsap-core/SKILL.md |
| GSAP React integration. | gsap-react | /home/matias/.config/opencode/skills/gsap-react/SKILL.md |
| GSAP scroll animations with ScrollTrigger. | gsap-scrolltrigger | /home/matias/.config/opencode/skills/gsap-scrolltrigger/SKILL.md |
| GSAP timelines and sequencing. | gsap-timeline | /home/matias/.config/opencode/skills/gsap-timeline/SKILL.md |
| GSAP plugins setup/usage. | gsap-plugins | /home/matias/.config/opencode/skills/gsap-plugins/SKILL.md |
| GSAP performance optimization. | gsap-performance | /home/matias/.config/opencode/skills/gsap-performance/SKILL.md |
| GSAP utils helpers. | gsap-utils | /home/matias/.config/opencode/skills/gsap-utils/SKILL.md |
| Create/update GitHub issues. | issue-creation | /home/matias/.config/opencode/skills/issue-creation/SKILL.md |
| Create high-quality GitHub PRs. | github-pr | /home/matias/.config/opencode/skills/github-pr/SKILL.md |
| Branch+PR flow with issue-first rules. | branch-pr | /home/matias/.config/opencode/skills/branch-pr/SKILL.md |
| Create Jira epic. | jira-epic | /home/matias/.config/opencode/skills/jira-epic/SKILL.md |
| Create Jira task. | jira-task | /home/matias/.config/opencode/skills/jira-task/SKILL.md |
| Build new skill files and docs. | skill-creator | /home/matias/.config/opencode/skills/skill-creator/SKILL.md |
| Discover/install relevant skills. | find-skills | /home/matias/.config/opencode/skills/find-skills/SKILL.md |
| Adversarial dual-review protocol. | judgment-day | /home/matias/.config/opencode/skills/judgment-day/SKILL.md |
| Ultra-terse response mode. | caveman | /home/matias/.config/opencode/skills/caveman/SKILL.md |

## Compact Rules

### typescript
- Use `as const` objects then derive union types; avoid manual unions.
- Keep interfaces flat; split nested shape into named interfaces.
- Prefer readonly props/arrays.
- Avoid `any` and implicit `any`.
- Prefer inference; add annotation only when needed.
- Narrow with type guards; avoid unsafe `as`.
- Avoid enums; use const objects.

### react-19
- Do not add useMemo/useCallback by default.
- Prefer server components first; add `use client` only when needed.
- Use modern form/action patterns.
- Keep components pure and deterministic.
- Optimize by architecture, not micro-hooks.

### nextjs-15
- Use App Router conventions.
- Prefer server data fetching.
- Use Server Actions for mutations.
- Keep boundaries explicit between server/client.
- Co-locate route logic per segment.

### zod-4
- Use Zod v4 API forms, not v3-deprecated helpers.
- Keep schemas composable.
- Infer TS types from schema.
- Validate external boundaries only.
- Return structured error maps.

### tailwind-4
- Use `cn()` style composition for classes.
- Prefer theme tokens/variables from Tailwind v4 config.
- Do not inject raw `var()` inside className utility strings.
- Keep utility sets readable; extract variants when repeated.
- Prefer semantic component wrappers for large class blocks.

### pytest
- Use fixtures for setup/teardown.
- Use markers to segment slow/integration/e2e.
- Prefer parametrized tests over duplicated cases.
- Mock external I/O boundaries.
- Keep assertions specific and readable.

### playwright
- Prefer stable locators (role, label, testid).
- Use page objects for repeated workflows.
- Avoid fixed sleeps; wait for states.
- Isolate test data per scenario.
- Keep E2E scope user-visible behavior.

### go-testing
- Table-driven tests for logic branches.
- Keep deterministic tests; avoid timing flakes.
- Use httptest for HTTP flows.
- Separate unit vs integration clearly.
- Assert errors and edge cases explicitly.

### ai-sdk-5
- Follow AI SDK v5 APIs; avoid v4 patterns.
- Keep model/provider abstractions explicit.
- Stream responses with supported primitives.
- Type tool contracts strongly.
- Handle retries/timeouts at transport boundary.

### django-drf
- Use ViewSets + Serializers consistently.
- Keep validation in serializer layer.
- Use filters/pagination explicitly.
- Keep permission/auth explicit per endpoint.
- Avoid business logic in views.

### gsap-core
- Animate transform/opacity first.
- Use `gsap.to/from/fromTo` consistently.
- Centralize defaults/easing where possible.
- Respect reduced-motion preferences.
- Scope selectors to component root.

### gsap-react
- Use `useGSAP`/context for lifecycle-safe animation.
- Bind animations to refs, not global selectors.
- Revert/cleanup on unmount.
- Register plugins once.
- Avoid layout-thrashing properties.

### gsap-scrolltrigger
- Register ScrollTrigger before use.
- Use clear trigger/start/end definitions.
- Use scrub/pin intentionally; test mobile behavior.
- Refresh triggers after layout changes.
- Respect reduced-motion fallback.

### gsap-timeline
- Use timelines for sequence choreography.
- Use position parameters instead of manual delays.
- Nest timelines for modular composition.
- Keep labels for maintainability.
- Control playback state via timeline API.

### gsap-plugins
- Register each plugin before first use.
- Keep plugin usage isolated to needed modules.
- Validate plugin availability in build/runtime.
- Prefer official plugin APIs over custom hacks.
- Cleanup plugin side-effects on teardown.

### gsap-performance
- Prefer transform over layout properties.
- Avoid forced sync layout reads during tween.
- Batch updates and avoid per-frame allocations.
- Use `will-change` sparingly.
- Profile FPS on target devices.

### gsap-utils
- Use mapRange/clamp/normalize for value transforms.
- Use snap/wrap for cyclical interactions.
- Use toArray for robust node lists.
- Compose small utility pipelines.
- Keep math helpers centralized.

## Project Conventions

| File | Path | Notes |
|------|------|-------|
| AGENTS.md | /mnt/d/Proyectos/telegram-opencode/AGENTS.md | Index/conventions file |

Read listed convention files for repo-specific rules.
