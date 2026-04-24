# Skill Registry

**Delegator use only.** Any agent that launches sub-agents reads this registry to resolve compact rules, then injects them directly into sub-agent prompts. Sub-agents do NOT read this registry or individual SKILL.md files.

See `_shared/skill-resolver.md` for the full resolution protocol.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| When building AI chat features - breaking changes from v4. | ai-sdk-5 | /home/matias/.config/opencode/skills/ai-sdk-5/SKILL.md |
| When structuring Angular projects or deciding where to place components. | angular-architecture | /home/matias/.config/opencode/skills/angular/architecture/SKILL.md |
| When creating Angular components, using signals, or setting up zoneless. | angular-core | /home/matias/.config/opencode/skills/angular/core/SKILL.md |
| When working with forms, validation, or form state in Angular. | angular-forms | /home/matias/.config/opencode/skills/angular/forms/SKILL.md |
| When optimizing Angular app performance, images, or lazy loading. | angular-performance | /home/matias/.config/opencode/skills/angular/performance/SKILL.md |
| When creating a pull request, opening a PR, or preparing changes for review. | branch-pr | /home/matias/.config/opencode/skills/branch-pr/SKILL.md |
| When building REST APIs with Django - ViewSets, Serializers, Filters. | django-drf | /home/matias/.config/opencode/skills/django-drf/SKILL.md |
| When creating PRs, writing PR descriptions, or using gh CLI for pull requests. | github-pr | /home/matias/.config/opencode/skills/github-pr/SKILL.md |
| When writing Go tests, using teatest, or adding test coverage. | go-testing | /home/matias/.config/opencode/skills/go-testing/SKILL.md |
| When creating a GitHub issue, reporting a bug, or requesting a feature. | issue-creation | /home/matias/.config/opencode/skills/issue-creation/SKILL.md |
| When user asks to create an epic, large feature, or multi-task initiative. | jira-epic | /home/matias/.config/opencode/skills/jira-epic/SKILL.md |
| When user asks to create a Jira task, ticket, or issue. | jira-task | /home/matias/.config/opencode/skills/jira-task/SKILL.md |
| When user says "judgment day", "judgment-day", "review adversarial", "dual review", "doble review", "juzgar", "que lo juzguen". | judgment-day | /home/matias/.config/opencode/skills/judgment-day/SKILL.md |
| When working with Next.js - routing, Server Actions, data fetching. | nextjs-15 | /home/matias/.config/opencode/skills/nextjs-15/SKILL.md |
| When writing E2E tests - Page Objects, selectors, MCP workflow. | playwright | /home/matias/.config/opencode/skills/playwright/SKILL.md |
| When writing Python tests - fixtures, mocking, markers. | pytest | /home/matias/.config/opencode/skills/pytest/SKILL.md |
| When writing React components - no useMemo/useCallback needed. | react-19 | /home/matias/.config/opencode/skills/react-19/SKILL.md |
| When user asks to create a new skill, add agent instructions, or document patterns for AI. | skill-creator | /home/matias/.config/opencode/skills/skill-creator/SKILL.md |
| When styling with Tailwind - cn(), theme variables, no var() in className. | tailwind-4 | /home/matias/.config/opencode/skills/tailwind-4/SKILL.md |
| When writing TypeScript code - types, interfaces, generics. | typescript | /home/matias/.config/opencode/skills/typescript/SKILL.md |
| When using Zod for validation - breaking changes from v3. | zod-4 | /home/matias/.config/opencode/skills/zod-4/SKILL.md |
| When managing React state with Zustand. | zustand-5 | /home/matias/.config/opencode/skills/zustand-5/SKILL.md |

## Compact Rules

Pre-digested rules per skill. Delegators copy matching blocks into sub-agent prompts as `## Project Standards (auto-resolved)`.

### ai-sdk-5
- Use `@ai-sdk/react` `useChat` with `DefaultChatTransport` instead of `ai` v4 helpers.
- Messages API exposes `sendMessage`; do not rely on `handleSubmit`/`handleInputChange` v4 signatures.
- UIMessage now stores rich content (roles/types); adjust renderers accordingly.
- Remove legacy `api` prop patterns; configure transport with `/api/chat` endpoint.
- Update middleware/server handlers to new SDK request/response shapes.

### angular-architecture
- Apply Scope Rule: one-feature usage → feature folder; multi-feature → `shared`.
- Feature structure: `features/[feature]/[feature].ts` with `components/`, `services/`, `models/`.
- Shared components/services live only in `features/shared/`; avoid dumping common/ folder misuse.
- Core singletons (interceptors, guards, services) go in `src/app/core/`.
- Naming: folder name = main component name; keep flat, avoid deep nesting.

### angular-core
- Components are standalone by default; do not set `standalone: true` manually.
- Use function-based `input()/output()/model()` APIs, never decorator Inputs/Outputs.
- Prefer `ChangeDetectionStrategy.OnPush` with signals; avoid mutable shared state.
- Use `inject()` for DI instead of constructor injection where possible.
- Use Angular control-flow blocks (`@if`, `@for`) not legacy `*ngIf/*ngFor` in new code.

### angular-forms
- Choose Signal Forms for new signal-based apps; Reactive Forms for production stability; template-driven only for simple cases.
- Model forms with `form()` and validators (signals) or `FormBuilder` (reactive); avoid mixing patterns.
- Keep validation declarative; surface errors via control state, not manual booleans.
- Prefer strongly typed form models; avoid `any` in controls.
- Encapsulate form logic in components/services; do not manipulate DOM directly.

### angular-performance
- Use `NgOptimizedImage` with `ngSrc`, explicit width/height; add `priority` for LCP.
- Lazy-load routes/components; leverage `@defer` for non-critical content.
- Avoid synchronous heavy work in constructors; defer to lifecycle/hooks.
- Ensure SSR-friendly patterns; avoid direct window/document in server context.
- Audit change detection hotspots; use OnPush and `trackBy` in repeats.

### branch-pr
- Every PR MUST link an approved issue; blank PRs are blocked.
- Exactly one `type:*` label required; follow branch naming `type/description`.
- Use PR template; include summary and testing notes; no WIP titles.
- Run required checks (incl. shellcheck for scripts) before opening.
- Conventional commits on branch; keep scope aligned with issue.

### django-drf
- Use `ModelViewSet` with proper `queryset`, `serializer_class`, `permission_classes`.
- Override `get_serializer_class` per action; use dedicated serializers for create/update.
- Enable filtering via `filterset_class`; respect DRF pagination/permissions.
- Use `@action` for custom endpoints; return `Response` with proper status codes.
- Avoid fat serializers; validate with `Serializer` methods not view logic.

### github-pr
- PR title MUST be a conventional commit (`type(scope): desc`).
- Description: Summary bullets, Testing section, Issue link required.
- Link the approved issue; keep one `type:*` label.
- Squash small related commits; avoid WIP/"minor" titles.
- Do not skip checks; ensure tests/linters noted in PR body.

### go-testing
- Prefer table-driven tests; name cases and use subtests with `t.Run`.
- Mark helpers with `t.Helper()`; use `t.Parallel()` where safe.
- For Bubbletea, use teatest harness; mock TUI IO deterministically.
- Keep golden files for stable outputs; place under `testdata/`.
- Avoid global state leakage; reset env/config per test.

### issue-creation
- Always use provided templates; blank issues are disallowed.
- Search for duplicates before filing; set status to `needs-review` by default.
- Include reproduction/requirements; keep scope to one problem.
- Questions go to Discussions, not Issues.
- Maintainer must mark `status:approved` before any PR.

### jira-epic
- Create epics for multi-task/large features; include Figma link if available.
- Write 2-3 paragraph overview plus sectioned requirements.
- Capture dependencies, risks, and acceptance criteria per section.
- Split work across components (API/UI/SDK) as child tasks.
- Keep scope bounded; note sequencing between tasks.

### jira-task
- Split multi-component work into separate tasks (API/UI/SDK) instead of one big task.
- Include clear acceptance criteria and definition of done.
- Reference parent epic/issue; capture prerequisites and dependencies.
- For bugs: independent sibling tasks per component; prioritize blocking paths.
- Keep tasks reviewable within one session; avoid vague titles.

### judgment-day
- Run two independent blind judges plus fix agent; up to two iterations then escalate.
- Apply Skill Resolver: inject matching compact rules for target files before judging.
- Judges review same target separately; fix agent merges findings and reruns judges.
- If no registry, warn and proceed with generic standards.
- Stop after both judges approve or after iteration limit.

### nextjs-15
- Use App Router structure (`app/` with layout/page/error/loading/not-found`).
- Components are server by default; add `"use client"` only when needed for hooks/DOM.
- Use Server Actions for mutations; avoid API routes when possible.
- Co-locate route groups `(group)/`; keep private components under `_components`.
- Define metadata via exported objects/functions, not `<Head>`.

### playwright
- If MCP tools available: explore via snapshot/navigate before writing tests.
- Use Page Object Model; prefer `getByRole`/accessible selectors over brittle queries.
- Avoid fixed waits; use expect/locators with timeouts.
- Cover full flows (loading/success/error) with screenshots when needed.
- Keep tests isolated; reset state/fixtures between cases.

### pytest
- Name tests `test_*`; organize with classes/modules; use fixtures for setup/teardown.
- Prefer `pytest.fixture` with scopes; use parametrization for matrix cases.
- Use `with pytest.raises(..., match=...)` for error paths.
- Avoid shared mutable state; clean temp/resources via fixtures/finalizers.
- Mark tests appropriately (`@pytest.mark.slow`, etc.) and keep assertions explicit.

### react-19
- Do NOT use `useMemo`/`useCallback` for perf; React Compiler handles it.
- Server Components by default; add `"use client"` only for interactivity/hooks.
- Use `use` for promises/context; prefer `useActionState`/`useOptimistic` for mutations.
- Named React imports only; no default `import React`.
- Avoid manual memoization patterns; keep components pure and simple.

### skill-creator
- Create a skill when a pattern repeats or differs from defaults; avoid trivial one-offs.
- Skill structure: `skills/{name}/SKILL.md` with optional assets/references.
- Frontmatter must include name/description/license/metadata; add triggers in description.
- Include actionable rules, decision trees, and examples; keep concise.
- Reference external docs via `references/` instead of embedding long copies.

### tailwind-4
- Use Tailwind classes directly; use `cn()` only for conditionals.
- Never use `var()` or hex colors in className; rely on semantic tokens.
- For dynamic values, use inline `style` with computed values, not arbitrary vars.
- Keep class order logical; prefer theme scale over custom values.
- Avoid custom CSS when a utility exists; use `fill`/`priority` image helpers when relevant.

### typescript
- Use `as const` objects then derive union types; avoid manual string unions.
- Keep interfaces flat; extract nested objects into their own interfaces.
- Prefer readonly props/arrays where possible; avoid `any`/implicit `any`.
- Use type inference; avoid redundant annotations; enable strict checks (`tsc --noEmit`).
- Narrow types with guards instead of `as`; avoid enums in favor of const objects.

### zod-4
- Use new helpers (`z.email()`, `z.uuid()`, `z.url()`); `z.string().min(1)` replaces `nonempty`.
- Provide object error messages via options `{ error: "..." }` not `required_error`.
- Use `safeParse` for validation flow; return formatted errors.
- Compose schemas via `.refine`/`.transform`; keep defaults explicit.
- Prefer branded types for identifiers; avoid loose `any` schemas.

### zustand-5
- Build stores with `create` and updater functions; avoid direct state mutation.
- Use selectors to prevent unnecessary re-renders; prefer `useStore(selector, shallow)`.
- Add middleware (`persist`, `devtools`, `subscribeWithSelector`) as needed; configure keys explicitly.
- Keep actions synchronous/pure; handle async outside then update via set.
- Reset state helpers provided; avoid global singleton side-effects during SSR.

## Project Conventions

| File | Path | Notes |
|------|------|-------|
| AGENTS.md | /mnt/d/Proyectos/telegram-opencode/AGENTS.md | Repository instructions — references files below |
| Source entrypoint | /mnt/d/Proyectos/telegram-opencode/src/index.ts | Referenced by AGENTS.md |
| Mock backend | /mnt/d/Proyectos/telegram-opencode/mock/opencode-mock.ts | Referenced by AGENTS.md |
| Local start script | /mnt/d/Proyectos/telegram-opencode/start-local.js | Referenced by AGENTS.md |
| Local stop script | /mnt/d/Proyectos/telegram-opencode/stop-local.js | Referenced by AGENTS.md |
| Runtime lockfile | /mnt/d/Proyectos/telegram-opencode/.local-runtime.json | Referenced by AGENTS.md |
| Documentation | /mnt/d/Proyectos/telegram-opencode/docs/ | Referenced by AGENTS.md |
