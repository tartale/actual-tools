# Project rules

## Privacy mode (Retirement page)

**The test**: privacy mode should make the screen safe to show a stranger for demo purposes.
Apply that test to any new field before deciding whether to blur it, rather than guessing.

**Sensitive (blur it)**:
- Personal dollar amounts — anything that's *this person's own* money: balances, contributions,
  spend, payments, payoff amounts, chart axis/tooltip/marker dollar figures, etc.
- Birth date and current age.
- A real personal-timeline fact tied to an actual account or decision: pension start age, Social
  Security claiming age, Rule of 55 separation age, a debt's own payoff age.

**Not sensitive (leave it readable)**:
- IRS limits and other fixed, published figures (contribution caps, tax brackets) — public and
  identical for everyone, not personal data.
- Generic modeling knobs with no real-world commitment behind them: the retirement ages being
  *compared* (hypothetical what-ifs, not a decision), plan-to-age (a conservative horizon, not a
  lifespan estimate), inflation mean/stddev, simulation count, minimum withdrawal assumption,
  expense adjustment %, spend history window.
- Plain labels, category/account names, percentages that aren't themselves a dollar amount.

The dividing line for an age specifically: is it a real fact about this person's actual plan (an
account's real terms, a decision they've made), or a hypothetical/modeling input used to explore
scenarios? The former is sensitive; the latter isn't.

**Blur only the sensitive number itself, never the surrounding label or context it's shown with**
("Debt Paid Off: -$50K/yr" blurs just `50K`, not the name; "reachable at age 59" blurs just `59`,
not "reachable at age"). A demo viewer should still be able to tell WHAT a blurred figure is (a
dollar amount, an age, which account it belongs to), just not its value.

**A dollar figure keeps its own `$` (and any leading `-`) visible too**, so a blurred number still
reads as "this is a dollar amount" rather than an unreadable smudge.

Two separate masking mechanisms exist, for two separate contexts:

- **Plain HTML** (tiles, prose findings): `app.js`'s `moneyHtml` splits a formatted dollar string
  into its `$`/`-` prefix and a `<span class="money">` around the digits; `style.css`'s
  `body.privacy .money { filter: blur(6px) }` does the actual hiding, reacting live to the
  `body.privacy` class with no re-render needed.
- **Chart SVG and hover tooltips** (axis labels, markers, both charts' tooltips): `app.js`'s
  `moneyMaskText`/`ageMaskText` swap the real digits for a literal `~~~~~`/`~~` placeholder instead
  — the same convention Actual's own UI uses. CSS `filter: blur()`
  does not reliably render on SVG `<tspan>` elements (confirmed: `getComputedStyle` reports the
  rule matched, but the browser doesn't paint it), so chart text can't use the blur approach at
  all. Tooltip content is masked the same way for consistency, since it's rebuilt from scratch on
  every hover anyway. Because content-swapping changes the actual text rather than a filter on top
  of it, it does NOT react live to the `body.privacy` class the way `.money` does — a chart drawn
  before privacy mode is toggled needs an explicit re-render to pick up the new state. That
  re-render is wired into the privacy toggle itself (`applyPrivacyMode` calls `renderCheckResult`
  against the last check response), not left for the next natural recheck.

Both helpers return the real value unchanged when privacy mode is off, so callers use them
unconditionally rather than branching themselves.

Field-specific `<input>`/`<select>` elements that can't be wrapped in a span (birth date, pension
start age, etc.) use their own `body.privacy #id` rule in `style.css` instead. See the doc comments
on each rule in `style.css`'s privacy-mode block for the reasoning behind individual fields.

Server-built prose (Finding titles/detail in fire-analysis.ts) spells a sensitive age out as one of
three exact phrases -- `at age N`, `around age N`, or `access age N` -- and a non-sensitive one
(a retirement age being compared, plan-to-age) as plain `age N` with no such lead-in. `app.js`'s
`moneyify` regex-matches only those three lead-ins, so a new sensitive age in generated prose needs
one of them to get picked up, and a new non-sensitive one needs to avoid all three.
