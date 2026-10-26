# OpenReview design

The look is warm ink on parchment. Hairline borders do most of the work before any shadow
appears. One ember accent marks links and emphasis, and each screen has a single dark primary
action. The visual reference is cursor.com, via the Refero "Cursor" style. The colours below are
taken from cursor.com's own stylesheet.

All styling lives in [`app/globals.css`](app/globals.css). It uses plain CSS with semantic class
names and design tokens. There is no Tailwind, and there are no CSS modules. Markup should use the
existing classes and tokens; avoid inline colours.

## Principles

These hold for the public site. The signed-in dashboard, sign-in and guided setup follow Greptile's look instead (white surfaces, 2px corners, Anybody 600 titles): see [Dashboard](#dashboard).

- **Hairlines before shadows.** Cards, tables and inputs use a 1px `--line` border. Only things that float get a shadow: popovers, the toast, and the app windows on the landing page.
- **One accent, used sparingly.** Ember is for links, focus rings, emphasis and the dot in the logo. Never use it as a background fill.
- **Two weights.** Inter at 400 for headings and body text, 500 for labels and small headings. Headings never use 600 or 700, and they tighten as they grow.
- **Monospace for machine text.** File paths, SHAs, timestamps, metric labels, badges and code are set in JetBrains Mono.
- **Square-ish corners.** Use 4px on controls, cards and tiles, and 8px on popovers and windows. No pills. Main tabs are the exception: they are square, so the hover fill meets the rule below them.
- **No gradients, glows, pure white or pure black.**
- **Motion explains state; on the landing page it also tells the story.**
  - In the app, entrances are short (240–320 ms; tabs are quicker, see Tabs), and loops are kept for waiting states, such as a provider that isn't connected yet or files that are still indexing.
  - The landing page is choreographed: content eases in over about a second as it scrolls into view, and one section plays as a pinned sequence. See [Landing motion](#landing-motion).
  - Everywhere, motion moves only transforms and opacity, and every screen is complete without it: `prefers-reduced-motion` stops the animation and leaves the final state.

## Tokens

These are defined on `:root`. Dark mode overrides them under `[data-theme="dark"]` and under
`prefers-color-scheme: dark` when the theme is set to System.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f7f7f4` | `#14120b` | Page canvas |
| `--surface` | `#f2f1ed` | `#1b1913` | Cards, sections, code |
| `--surface-2` | `#ebeae5` | `#201e18` | Hover rows, landing stages, diff hunk headers |
| `--surface-3` / `--soft` | `#e6e5e0` | `#26241e` | Secondary buttons, active navigation tile |
| `--surface-4` | `#e1e0db` | `#2b2923` | Secondary button hover |
| `--text` | `#26251e` | `#edecec` | Ink: body text, primary button fill |
| `--muted` | `#64635c` | `#a09f9b` | Secondary text; meets WCAG AA on `--bg` and `--surface` |
| `--text-ter` | `#8d8c86` | `#6f6e69` | Decorative only: line numbers, list markers |
| `--line` / `--line-strong` | ink at 10% / 20% | same | Hairlines / input borders and table header rules |
| `--accent` | `#c03c00` | `#ff6a26` | Link text; a darker ember so small text meets AA |
| `--ember` | `#f54e00` | `#f54e00` | Focus ring, chart emphasis series, logo dot |
| `--primary` / `--on-primary` | ink / parchment | ink / near-black | Primary buttons |
| `--success`, `--error`, `--warning` (+ `-bg`) | `#18704f`, `#b3264a`, `#7c5011` | `#5cc49b`, `#f0718f`, `#d9a352` | Status text on translucent tints |
| `--radius` / `--radius-lg` | 4px / 8px | | Controls and cards / popovers and windows |
| `--shadow-elevated` | Cursor's product shadow | deeper | Landing app windows |
| `--shadow-popover` | soft, small | deeper | Menus and the toast |

Fonts are bundled from npm in `app/layout.tsx`, so builds never fetch them:

- `--font-sans` is Inter Variable, with `cv11` and `ss01` enabled. It is used for UI, headings and body text.
- `--font-mono` is JetBrains Mono Variable. It is used for code, paths, metadata, badges and metric labels.
- `--font-serif` is EB Garamond. It is used only for editorial subheads in review summaries and docs.

## Type scale

| Role | Size and weight | Tracking |
|---|---|---|
| Landing display | 72px / 400 (`clamp` down to 40px) | −0.03em |
| Landing section heading | 36px / 400 | −0.02em |
| Page `h1` | 36px / 400 | −0.02em |
| `h2` (card titles) | 16px / 500 | −0.005em |
| Body | 14px / 400, line height 1.55 | — |
| `.muted` | 13px | — |
| Mono metadata | 11–12px | — |

## Components

All of these are global classes in `app/globals.css`.

- **Buttons.**
  - A bare `button` or `.button` is secondary, with a `--soft` fill.
  - `.primary` is the ink fill. Use one per group.
  - `.danger` is crimson text on a crimson hairline.
  - `.small` is a compact variant.
- **Inputs.** Inputs, selects and textareas have a transparent background and a `--line-strong` border, with an ember focus ring. Selects use a custom chevron. `label` stacks its control under the text; `label.check` puts a checkbox inline with its text.
- **Cards.** A bare `section` is a card: `--surface`, a hairline border and a 4px radius. An `article` inside a card is separated by hairlines. `.empty` is a dashed, transparent card for empty states.
- **App chrome** (`app/dashboard/(portal)/layout.tsx`, `app/dashboard/portal.tsx`). The portal layout renders the chrome once. It stays mounted while pages change, so switching tabs never shows a loading screen. See [Dashboard](#dashboard) for its layout.
- **Tabs** (`app/dashboard/tabs.tsx`).
  - `PrimaryTabs` and `SubNav` are links. A click marks the tab at once and navigates in a transition, so the old page stays on screen until the new one is ready. `SubNav` gives the review page its Overview, Review, Discussion and Code tabs (`?tab=`).
  - `PanelTabs` are ARIA tabs over panels that are all rendered and hidden until selected, used by the landing replicas. Arrow keys, Home and End move between tabs.
  - In-page tabs are 32px. A bordered `.tab-box` slides over the list's hairline, and the panel that comes in fades up 4px.
  - Timing: the main bar slides in 220 ms `cubic-bezier(0.16, 1, 0.3, 1)`; the box and the panel fade take 200 ms; sub-navigation rows take 150 ms. Bars jump into place on first paint and on resize.
- **Icons** (`app/ui/icons.tsx`). Phosphor regular paths (MIT), drawn inline and `aria-hidden`. Each sits beside a visible or screen-reader label, usually at 16px.
- **Data.**
  - `.metrics` is a hairline-divided grid with mono labels and 36px tabular numbers.
  - `.badge` is a mono 11px tinted chip, and status names map to tones. For example, `critical` and `high` are red, `medium` is amber, `completed` is green, `running` is ember, and `low` and `queued` are muted.
  - Findings show priority rather than raw severity: `priority(f)` in `app/dashboard/sections/shared.tsx` renders P0–P3 (from `src/priority.ts`) in the severity's badge tone, plus a Security tag for security findings.
  - Tables use mono muted headers and hairline rows.
  - `LineChart` and `BarList` (`app/ui/charts.tsx`) use ink, ember, green and amber series.
- **Diff** (`app/dashboard/diff-files.tsx`): mono text, translucent green and red line tints, and a finding inset card after the line it anchors to.
- **Brand.** The mark is four lines of code, the middle two indented, with an ember dot pinned beside the third: a finding on a line.
  - The lines take the text colour and invert with the theme. The dot is the one place the logo uses `--ember`.
  - Cuts share one geometry, each fitted to a pixel grid. Use each only where it is fitted:
    - **Master** (`brand/openreview-mark.svg`): 24 px and up, except at multiples of 16.
    - **Header cut** (`Mark` in `app/ui/logo.tsx`): exactly 20 px. Its edges land on whole device pixels at 2x; on 1x screens they anti-alias by half a pixel.
    - **Small cut** (`brand/openreview-mark-small.svg`): multiples of 16 px. It is the tab icon (`app/icon.svg`) and the 128 px artwork inside the 180 px `app/apple-icon.png`.
    - **Favicon tile** (`brand/openreview-favicon.svg`): `app/favicon.ico` at 16, 32 and 48 px. It is a separate 16 px drawing on an ink tile, because a static ICO cannot follow the theme.
  - Theme-following uses (`Mark`, `app/icon.svg`) recolour one geometry. The reversed files, with lines thinned for dark backgrounds, are for static artwork on ink: the apple icon, slides and print.
  - Use the one-colour version (`-mono`) where the accent can't be reproduced.
  - The Open Graph image (`app/opengraph-image.tsx`) uses the master.

- **Guided setup** (`app/dashboard/onboarding/`).
  - A full-screen `.wizard` sits outside the portal chrome. A step panel on the left faces a `.wizard-stage` illustration on the right, and a sticky `.wizard-bar` holds Back and Next. Next accepts ⌘/Ctrl+Enter, and focus moves to each step's heading.
  - Illustrations (`art.tsx`) are SVG line work on a dot grid. They use the ink tokens and ember once per panel, never as a fill. Each one is `aria-hidden`, and a mono caption with `aria-live` beside it carries the meaning.
  - The code graph is driven by real indexing progress and a sample of indexed paths (`src/onboarding-graph.ts`).
  - Configuration previews follow unsaved form state and reuse the product's own rules (`src/onboarding-preview.ts`). Trigger outcomes are kept in parity with `pullRequestTrigger` by a test.

## Dashboard

The signed-in dashboard follows Greptile's web app as captured on Mobbin: its eight tabs, page anatomy, components, flows and motion, in OpenReview's identity (our name, logo and ember accent, never Greptile's green). It overrides the parchment tokens above on `:root:has(.shell.portal)`, so dialogs rendered into `<body>` match.

- **Look.** A `#fafafa` page, white cards and controls, `#e5e5e5` hairlines, 2px corners and a near-black primary. No shadows except on toasts. DM Sans for text, Anybody 600 for page, section and dialog titles, and Space Mono for uppercase labels (table headers, card titles, status chips). Dark mode maps the same roles to neutral greys.
- **Information architecture** (`app/dashboard/routes.ts`): Analytics · Repositories · Code Review Settings · Custom Context · Pull Requests · Code Providers · Integrations · Organization Settings. Each tab URL maps to the internal section the loader and views use; the old Memory and Settings URLs redirect (`next.config.ts`). Chat opens from the header's chat icon. Personal Settings opens from the account menu and replaces the tabs with "‹ Back · Personal Settings".
- **Chrome.** A sticky `.portal-top`: an optional 45px trial banner, a 49px identity row (logo; the organization menu with a role badge and ⇅; 27px icon buttons for Chat, Docs, Refer someone and the account menu) and a 31px row of text tabs with the sliding 2px bar. `--header-h` is 81px, 126px with the banner and 50px in Personal Settings. Below 640px the tab row scrolls sideways.
- **Pages.** A centred 1142px column under a `.page-header`: a 24px Anybody title, a 14px subtitle and actions on the right. Settings-style tabs (Code Review Settings, Organization Settings, Personal Settings) put a 205px `SettingsNav` (`app/dashboard/sidebar.tsx`) beside the content: rows on a hairline rail, the current one filled and marked with a 2px bar. On Code Review Settings it lists the page's sections and marks the one in view as you scroll. Below 600px it becomes a select.
- **Components** (the "Greptile components" block in `app/globals.css`): section headings outside their cards; setting rows and option cards with toggles (`input.toggle`); outline, `.primary` and soft `.danger` buttons; search fields with italic placeholders; square tables with mono headers and full-height column rules; status chips; pagination; bulk bars; danger zones; notice banners; flat menus (`.menu` in `PortalDisclosure`); `Dialog` (`app/ui/dialog.tsx`: a white wash, a square box, type-to-confirm); docked drawers; and bottom-right toasts. Each area's own rules follow in its "Area:" block.
- **Motion.** Modals fade and rise 6px (180 ms), drawers slide in from the right (220 ms), menus fade down 4px (150 ms), toasts slide up (220 ms) and pending status chips spin. Reduced motion stops all of them.
- **Sign-in and guided setup** use the same fonts and greys (`app/auth-screen.tsx`, `app/dashboard/onboarding/`). Sign-in pairs the form with an original animation of a review in progress: a scan band reads down a diff and findings slide in beside the lines it flags, with the ember dot from the logo.

## Public site

- **Shared chrome.** `SiteHeader` and `SiteFooter` (`app/site-chrome.tsx`) are shared by the landing page, docs and changelog. The footer carries the Appearance picker.
- **Landing layout** (`app/page.tsx`): left-aligned hero, then alternating 5:7 feature rows, a provider strip, "How it works", a terminal card, the comparison table, the FAQ and a closing call to action.
- **Product visuals are interactive replicas of real screens** (`app/landing/demo.tsx`), not drawings or screenshots.
  - They render the dashboard's own markup and shared components (`DiffFiles`, `ChartCard`, `PortalDisclosure` and the `status()` and `priority()` badges) with sample content from `app/landing/sample.ts`, inside a `.replica-shell` that carries the dashboard's palette and fonts. This keeps them in step with the app and its theme.
  - Visitors can click through them, as in a working app. The hero is a small dashboard with its own section tabs. The feature windows each demonstrate one thing: evidence shown in its file, a re-review, chat, the agent hand-off and analytics filters.
  - Nothing calls the backend. Slow work (reviews, chat answers, the bridge hand-off) is simulated with timers, and the status text matches the real screens. Each window bar says "Demo".
  - The chat and summary windows play once on their own when half in view: a sample question, then a re-review. A click or key press inside a window first cancels it, and reduced motion turns it off.
  - On desktop, windows have a fixed height and scroll inside. On phones they grow to fit their content, so a swipe always scrolls the page.
  - Heavier rendering happens on the server (`app/landing/replicas.tsx`): markdown for chat answers and summaries, and the settings previews computed with guided setup's rules (`src/onboarding-preview.ts`). Only the click handling ships to the browser.
  - Links and tabs inside a window are buttons styled like the app's links. In-window headings use `role="presentation"`, so they stay out of the page outline. A visually hidden `figcaption` names each window.
  - Sample evidence must quote `sources` exactly, and diffs must match it; `tests/landing-demo.test.ts` checks both.
  - When a dashboard screen changes, update the matching replica in the same change.
- **Docs and changelog** use a compact left navigation and a 768px reading column. Subheads are set in EB Garamond.

### Landing motion

The landing page's motion lives in `app/landing/motion.tsx`, with its styles at the end of the landing block in `app/globals.css`. It uses GSAP with ScrollTrigger, ScrollSmoother and SplitText. `app/landing/motion-loader.tsx` loads it as a separate chunk after hydration, so it never delays the first paint.

- **Hero entrance (CSS).** It plays on the first frame without waiting for JavaScript:
  - The headline lines rise through masks.
  - The lede lifts in already readable, so the first screen's main text is painted on the first frame.
  - The actions and links fade up.
  - The demo window rises last, which also keeps a half-streamed window off screen on slow connections.
- **Desktop pointers only** (at least 1024px wide, with a fine pointer). Touch screens keep native scrolling.
  - Smooth scrolling: ScrollSmoother over `#smooth-wrapper > #smooth-content`.
  - Light parallax on elements with `data-speed`.
  - The hero window settles from 94% to full size as it scrolls into place.
  - "How it works" pins while a 2px ink track draws across the four steps, and each step comes up as the track reaches it.
  - Primary calls to action lean up to 6px toward the pointer.
- **Every width:**
  - `data-split` headings reveal line by line, `data-reveal` items rise in, and `data-stagger` lists bring their children in turn.
  - Feature windows slide in from their own side while the copy cascades in beside them.
  - The terminal types its commands, with a blinking caret once it is done.
  - The closing line rises a character at a time, then its full stop lands as the ember dot.
- **Header.** It is sticky on the landing page, and fixed above the smoothed content while smooth scrolling runs. It hides while reading down and comes back on the way up or when focused. Once the page moves it gains its hairline and draws reading progress as a 2px ink line.
- **Anchors.** In-page links glide to their section below the header and move focus there.
- **Nothing flashes.** No CSS hides content before JavaScript runs. An effect only puts content in its starting state while that content is still below the fold, so nothing the visitor has seen disappears. Sections further down are set up one per idle moment, so setup never blocks the main thread for long.
- **Still reachable.** Reveals fade with opacity, never `visibility`, so content waiting below the fold stays in the accessibility tree and the tab order. Focusing it scrolls it into view, which reveals it. Scrolling done by the browser itself (find in page, `scrollIntoView`) is handed to the smoother, so nothing jumps back on the next click.
- **Keeps your place.** Resizing past the desktop width, or turning reduced motion on or off, rebuilds the motion. The block the reader was looking at goes back to where it was.
- **Timing.** Eases are expo-out (`--ease-out` in CSS). Reveals take 0.8–1.1 s, with 0.07–0.09 s between items.
- **Reduced motion.** None of it runs, and the page as rendered is every effect's final state.
- **Adding content.** Give new content one of the `data-*` hooks rather than new code. Keep fixed-position UI outside `#smooth-wrapper`: it is transformed while smooth scrolling runs.

## Accessibility

- Text colours meet WCAG AA against the surfaces they sit on. `--text-ter` is never used for meaningful text.
- Focus is always visible: a 2px ember outline, or a 3px ring on inputs.
- Anything that scrolls on its own can take keyboard focus: tables use `ScrollTable` (`app/dashboard/scroll-table.tsx`), and other scroll areas get `tabIndex={0}` with a label.
- Links inside running text on public pages are underlined, so they don't rely on colour alone.
- Status is never shown by colour alone: badges always carry their text.
- Layouts hold at 390px without horizontal page scroll in both themes. Wide tables and diffs scroll inside their own containers. `pnpm test:e2e` checks this.
- `prefers-reduced-motion` turns off transitions (tab bars jump instead of sliding), the skeleton pulse, the tab panel and section-link fades, every guided-setup animation and all landing motion, including smooth scrolling.

## Adding UI

1. Reuse an existing class or component before adding one. Most screens need only `section`, `.row`, `.form-grid`, `.toolbar`, `.metrics`, `.badge` and the button classes.
2. If you need a new rule, add it to the matching block of `app/globals.css` (chrome, components, dashboard features or public site) and use tokens, never raw hex values.
3. Check the screen in light and dark, at desktop width and at 390px.
