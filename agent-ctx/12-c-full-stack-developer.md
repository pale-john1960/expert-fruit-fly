# Task 12-c — full-stack-developer (playground→lab deep link)

Task: Cross-tab deep link — "Run the real experiment" CTA in the Dopamine Playground (How It Works tab) jumps to the Brain Lab (tab 1) with the 24-trial classic conditioning wizard auto-armed.

Status: COMPLETE — verified end-to-end, lint exit 0, dev.log clean. Full details in the
worklog.md "Task ID: 12-c" section. Summary for downstream agents:

## Files touched (exclusive ownership)
- `src/lib/flybrain/store.ts` — added `LabIntent` type, `labIntent` field,
  `requestLabIntent(kind)` + `consumeLabIntent()` (take-and-clear). No persist
  middleware exists on this store, so the intent is ephemeral by construction.
- `src/components/fly/DopaminePlayground.tsx` — `runRealExperiment()` handler
  (store intent FIRST, then `window.dispatchEvent(new KeyboardEvent("keydown",
  {key:"1", bubbles:true}))` — page.tsx's public 1–5 hotkey contract, zero
  page.tsx edits — then `playSound("click")`); emerald-outline CTA
  "Run the real experiment" at the end of the card (44px, full-width mobile,
  aria-label, focus-visible ring, data-testid="cta-run-real-experiment") +
  caption "Same rule, real connectome — 928 neurons, 24 trials."
- `src/components/fly/BrainLab.tsx` — mount effect consumes the one-shot
  intent → `queueMicrotask(() => { startDemo(); setDeepLinkHint(true); })`
  (real wizard open handler, no duplicated logic; microtask deferral keeps
  react-hooks/set-state-in-effect happy AND lands before first paint);
  hint lifecycle effect (scrollIntoView + 6 s auto-dismiss, reduced-motion
  aware); dismissible emerald hint chip near the top of the lab
  (data-testid="deeplink-hint", role="status").

## Gotchas discovered (useful for everyone)
1. **shadcn outline Button + custom colors**: the variant's
   `dark:bg-input/30` / `dark:border-input` / `dark:hover:bg-input/50` WIN over
   plain `bg-emerald-500/10` etc. in dark mode (Tailwind v4 sorts dark:
   utilities after plain; tw-merge does not dedupe across variant scopes).
   Mirror every conflicting utility in `dark:` and `dark:hover:` scopes.
2. **Chrome stale `:is(.dark *)` matches**: toggling `html.dark` at runtime
   leaves stale computed styles on pre-existing elements — probe light mode
   with a freshly-appended clone element for the truth.
3. **react-hooks/set-state-in-effect** is error-level in this repo — defer
   mount-effect setState via `queueMicrotask`.
4. **agent-browser CDP hangs** under memory pressure → `agent-browser close`
   + reopen recovers.

## Round-trip contract (how the deep link works)
Radix Tabs unmounts inactive content, so the lab mounts fresh right after the
synthetic "1" keydown flips the tab; BrainLab's mount effect then consumes the
store intent exactly once. Clicking the CTA again re-arms; switching tabs
manually without a pending intent does nothing extra.
