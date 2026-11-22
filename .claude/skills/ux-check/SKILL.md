---
name: ux-check
description: Check the UX of kd-learn web screens before delivering UI work, and audit screens on request. Use after adding or changing any screen, component layout, navigation, list, form or panel in apps/web or packages/ui, or when asked to review or improve UI/UX. Takes screenshots of every screen (desktop and phone, light and dark), checks them against the DESIGN.md "UX" rules, and fixes what fails.
---

# ux-check

UI work is not done until you have looked at it. Tests prove behaviour, not that a screen reads well.

## 1. Rules

Read `DESIGN.md` sections "UX" and the token sections, and `apps/web/AGENTS.md` (Astryx rules: components only, no `<div>`, no raw px or hex). Product context: `plan/cai-thien-ux.md`.

## 2. Screenshots

```sh
pnpm --filter @kd-learn/web build
pnpm --filter @kd-learn/web shots            # all screens
pnpm --filter @kd-learn/web shots -g account # one group: "signed out", guest, account, admin
```

Pictures land in `apps/web/ux-shots/<desktop|phone>/<screen>-<light|dark>.png`. The script is `apps/web/e2e/shots/screens.shots.ts`: when you add a screen or a state (empty, error, a new panel), add a `shoot(...)` for it there.

Keep a "before" copy (`cp -r apps/web/ux-shots <scratchpad>/before`) when changing an existing screen, so you can compare.

## 3. Look

Open the pictures of every screen you touched, desktop and phone, light and dark (the Read tool shows images). For each, check:

| Check | Fails when |
| --- | --- |
| Frame | Content hugs the left edge of a wide screen; header and content do not line up |
| Main action | Two primary buttons, or the main action is not the most visible control |
| Navigation | Current place not marked; account actions mixed into the places; header over two rows on a phone |
| Alignment | An input not under the content it belongs to; uneven gaps between sections |
| Roles and hierarchy | Learner and tutor text look alike; a big heading over one line of content |
| States | A list with no empty state, a load with no spinner, an error with no way out, rows with no status |
| Disabled controls | Pale button with no reason given |
| Phone | Sideways scroll, a control cut at the edge, tap targets under 44 px, a panel opening by itself |
| Dark mode | Low contrast, a light block left in dark, a picture that keeps light colors |
| Copy | Same text twice on screen, labels that repeat the heading, vi/en missing (`packages/i18n/messages/`) |

## 4. Fix and repeat

Fix with Astryx components and props first (`pnpm exec astryx component <Name>`, `astryx search "<idea>"`). Rebuild, re-shoot, look again. Keep `data-testid`s, or update the e2e that use them in the same change. Then run the e2e (`pnpm --filter @kd-learn/web test:e2e --project=chromium --project=pixel`).

Report what you checked and what you changed, with the before and after pictures for anything visible.
