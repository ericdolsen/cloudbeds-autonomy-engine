# Gateway Park — Visual Style Guide

A short rulebook for applying the Lobby + Prairie design to the existing app.
Pair this with `gateway-theme.css`.

---

## The two profiles

The app has two surfaces, each gets one profile:

| Profile | Audience | Where it lives | Tone |
|---|---|---|---|
| **Lobby** (`.lobby`) | Guests | Self-service kiosk + any lobby-facing display | Classical, hotel-at-night, warm brass on charcoal |
| **Prairie** (`.prairie`) | Staff | Employee panel, reporting, knowledge base | Restrained, regional, sage on charcoal — easier on a long shift |

Both share the same charcoal/linen ground from the brand book. They differ on **accent color** (brass vs. sage) and **serif** (Fraunces vs. EB Garamond). That's it.

**Rule:** wrap the topmost element of any screen in `.lobby` or `.prairie`. Every component below that reads its colors and serif from CSS variables, so you never hardcode a hex value or a font name in a component.

```html
<!-- Customer-facing -->
<body class="lobby">
  <div class="kiosk">…</div>
</body>

<!-- Staff-facing -->
<body class="prairie">
  <div class="emp">…</div>
</body>
```

---

## Required fonts

Add to your host page `<head>` once. Don't import inside components.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

> **Note:** the brand book specifies **FreightDisp Pro**. Fraunces is a free Google Fonts substitute with similar bones. If the brand budget allows, license FreightDisp and self-host it — swap `--p-serif` in the `.lobby` block.

---

## Tokens (use these, never raw values)

All custom properties are defined per-profile. **Never** write `color: #C9A86A` in a component. Always reference the variable so it adapts when a screen swaps profiles.

| Variable | Role |
|---|---|
| `--p-deep` | Page background |
| `--p-deep-2` | Card / tile / sidebar surface |
| `--p-deep-3` | Hover surface |
| `--p-warm` | Inverted ground (linen — used for QR cards, room photos, light-mode pockets) |
| `--p-ink` | Primary type |
| `--p-ink-2` | Secondary / body type |
| `--p-ink-3` | Tertiary / metadata / hint type |
| `--p-rule` | 1px borders, dividers |
| `--p-accent` | Brass (Lobby) or Sage (Prairie). Used for status dots, active-nav, primary CTAs, key metrics, the italic crest |
| `--p-accent-2` | Lighter accent for hover states |
| `--p-accent-ink` | Type that sits *on* an accent fill |
| `--p-serif` | Display serif. Use for headlines, brand marks, the big clock, big metrics |
| `--p-radius` | 2px — a soft hairline of rounding, just enough to not feel sharp |

Body / UI text always uses **Inter** (inherited from `.lobby` and `.prairie`).

---

## Component classes

Already implemented in `gateway-theme.css`. Drop them on existing markup.

### Kiosk (Lobby only)
- `.kiosk` — fullscreen surface (1280×800 reference)
- `.kiosk-head`, `.kiosk-mark` (`.crest`, `.name`, `.sub`), `.kiosk-status` — top bar
- `.kiosk-clock` (`.kiosk-greeting`, `.kiosk-time` + `.ampm`, `.kiosk-date`, `.kiosk-rule`) — center hero
- `.kiosk-actions` + `.kiosk-tile` (`.ic`, `.text` > `.label` + `.help`, `.arrow`) — primary CTAs
- `.kiosk-secondary > button` — low-priority utility actions
- `.kiosk-foot` (`.qr`, `.qr-card`, `.qr-text`) — footer status + scan-to-check-in

### Employee panel (Prairie only)
- `.emp` — root sidebar+main shell
- `.emp-side`, `.emp-brand` (`.crest`, `.name`, `.sub`), `.emp-nav > .item` (+ `.active`), `.emp-status` — sidebar
- `.emp-main`, `.emp-eyebrow`, `.emp-h1`, `.emp-sub` — main column header
- `.emp-grid`, `.emp-card` (`.label`, `.metric`, `.metric-help`) — KPI / data cards
- `.emp-feed > .feed-row` (`.badge.ok` / `.warn` / `.err`, `.feed-text`, `.feed-time`) — activity log
- `.emp-reports > .emp-report > h3 + p + button` — generate-report cards

### Buttons (both profiles)
- `.btn-primary` — accent-fill CTA. Use one per screen.
- `.btn-ghost` — outline secondary

---

## Extension helpers (for screens not in the mockup)

When you need to style a screen we haven't drawn, use these primitives instead of inventing new ones:

| Class | Use |
|---|---|
| `.gp-surface` | Any card/panel with the standard chrome |
| `.gp-eyebrow` | Small uppercase label above a heading |
| `.gp-display` / `.gp-h1` / `.gp-h2` / `.gp-h3` | Display-serif headings — use these classes on `<div>`/`<h*>` instead of relying on tag selectors |
| `.gp-input` / `.gp-label` | Form inputs and their labels |

> **Why `.gp-h1` instead of just `<h1>`?** The host app's global stylesheet sets `<h1>` to `color: var(--stone-900)` (near black). On a charcoal background that's invisible. Either override per-component (we did this for `.emp-h1` and `.emp-report h3`), or use the `.gp-*` classes which always set color explicitly. The latter is more robust.

---

## Rules of thumb

When extending the design to new screens, follow these:

1. **One accent per screen.** A single status dot, one primary CTA fill, one active nav item. The accent should feel rare. If everything is accent, nothing is.

2. **Serif is for naming.** Brand marks, headlines, big numbers (the clock, key metrics). UI chrome — buttons, form labels, metadata, body copy — is always **Inter**.

3. **Italic = brand voice.** The little "est. South Dakota" crest, the "welcome home" greeting, decorative connectors (`Hotel & Suites`). Don't use italic for emphasis in body copy.

4. **Uppercase + wide tracking = system speech.** Status labels, eyebrows, button text, footer chrome. `letter-spacing: 0.18em–0.22em`, `text-transform: uppercase`. Reserve for short strings.

5. **Hairlines, not borders.** Almost every divider is `1px solid var(--p-rule)` (~10–12% opacity ink on the dark ground). Avoid heavy borders.

6. **Square corners with a hint.** `--p-radius: 2px`. Not 8px, not 12px. Pills (`border-radius: 999px`) are reserved for one thing only — the kiosk's secondary toggles or status chips, sparingly.

7. **No emoji, no flag-style icons.** Icons are 1.5px stroked SVG outlines, monochrome, sized to match the surrounding text (16px in the sidebar, 24px in tiles). The IconCheck / IconReceipt / IconHealth set in the mockup is the visual vocabulary — extend with the same line weight and stroke-cap style.

8. **Photography (when it appears) gets a brass rule.** A 2px horizontal gradient under any room photo, transparent → `--p-accent` → transparent. This is the brand book's "gold gradient" mention, applied with restraint.

9. **Don't fight the global stylesheet — override at the component level.** The existing `colors_and_type.css` has rules like `h1 { color: var(--stone-900); }`. Anywhere those will leak onto a charcoal surface, set `color:` explicitly on the component class. Or use `.gp-h1` etc.

10. **Same scale, both profiles.** Spacing, type sizes, and component proportions are identical between Lobby and Prairie. Only color and serif differ. Don't introduce a new spacing rhythm for the staff panel.

---

## Mapping to existing screens

When you're refactoring the existing app:

| Existing screen | Profile | Suggested class structure |
|---|---|---|
| Self-check-in landing | `.lobby` | `.kiosk` (we built this) |
| Reservation lookup, signature canvas, payment | `.lobby` | `.kiosk` shell, swap inner content. Use `.gp-input` / `.gp-label` for the lookup form. Single `.btn-primary` per step. |
| Front-desk dashboard | `.prairie` | `.emp` (we built this) |
| Reporting Center | `.prairie` | Reuse `.emp` shell. Inside `.emp-main`, lay out `.emp-card`s and `.emp-report`s. |
| Knowledge Base | `.prairie` | `.emp` shell. Body content gets `.gp-h2` / `.gp-h3` / paragraph styling — for long-form text consider relaxing line-height to 1.7 inside a `.gp-surface` reading container max-width 640px. |
| Confirmation / receipt screen | `.lobby` | `.kiosk` shell, replace center hero with a `.gp-display` confirmation, single `.btn-primary` "Done". |

---

## What's NOT in the theme yet (decide before building)

These exist in the working app but weren't part of the design pass — Claude Code should style them by extension, following the rules above:

- Multi-room reservation chooser
- Signature canvas chrome (the canvas itself is just `--p-deep-2` background with `--p-rule` border; the surrounding "sign here" UI follows form-input patterns)
- Cloudbeds-branded buttons inside Cloudbeds modules (leave Cloudbeds chrome alone — only restyle the surrounding shell)
- Error / failure states (use `.badge.err` for inline, `--p-accent` *not* for errors — reserve a separate red token if you need one. Suggest `#d47272` for ink on dark, mirroring the `.warn` pattern.)
- Loading / skeleton states (1px border + animated `--p-rule` shimmer is the simplest pattern)

---

## Quick checklist before merging a refactor

- [ ] Topmost element of every screen has `.lobby` or `.prairie`
- [ ] No raw hex values in any new CSS — all references go through `var(--p-*)`
- [ ] Headlines use `.emp-h1`, `.gp-h1`, etc. — not bare `<h1>` (or you've overridden color explicitly)
- [ ] Exactly one `.btn-primary` per screen
- [ ] Icons are 1.5px-stroke SVG outlines, currentColor
- [ ] No emoji; no rounded corners larger than 2px (except pills)
- [ ] `Inter` for all UI text; `--p-serif` for display + brand only
- [ ] Tested at 1280×800 (kiosk reference) and 1440×900+ (staff workstation)
