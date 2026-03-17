# Dashboard Demo Video - Animated HTML Showcase

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone, self-contained HTML page that animates through the BingX Bot dashboard screens with mock data — designed to be screen-recorded as a promotional/demo video.

**Architecture:** Single HTML file (`public/demo.html`) with inline CSS and JavaScript. Renders a pixel-perfect replica of the dark-mode dashboard UI. Auto-plays through scenes: splash → overview stats loading → data populating → bots summary → navigate to bots → bot accordion expanding → P&L live updates → accounts page → outro. No React/Next.js dependencies — pure HTML/CSS/JS for portability.

**Tech Stack:** HTML5, CSS3 (animations/transitions), vanilla JavaScript (timers/sequencing)

---

## Chunk 1: Create the Animated Demo Page

### Task 1: Create `public/demo.html`

**Files:**
- Create: `public/demo.html`

- [ ] **Step 1: Create the self-contained HTML demo file**

Create `public/demo.html` with all CSS/JS inline. The page auto-plays a ~30-second animation showcasing all dashboard screens with mock data.

**Animation Timeline (12 scenes):**

| Scene | Time | What Happens |
|-------|------|-------------|
| 1. Splash | 0–2s | "BingX Bot" logo + "Automated Grid Trading" subtitle fade in |
| 2. Layout | 2–3.5s | Sidebar slides in, header fades in |
| 3. Stats Loading | 3.5–4.5s | 4 stat cards appear with skeleton shimmer |
| 4. Stats Populate | 4.5–6.5s | Numbers count up (Balance $12,450, Equity $12,680, P&L +$230, Available $8,200) |
| 5. Bots Summary | 6.5–9s | Active bots card fades in (3 running, 1 stopped) |
| 6. Navigate Bots | 9–10.5s | Sidebar highlight switches, content transitions |
| 7. Bots List | 10.5–12s | Filter buttons, P&L summary, 4 bot accordions |
| 8. Bot Expand | 12–15s | BTCUSDT expands showing positions + orders |
| 9. P&L Update | 15–19s | Unrealized values animate with green flash |
| 10. Navigate Accounts | 19–20.5s | Switch to accounts page |
| 11. Balance Display | 20.5–23s | 8 balance cards animate in staggered |
| 12. Outro | 23–26s | Fade to "BingX Bot — Trade Smarter" |

**Visual specs:** Dark mode (#0a0a0a bg), HeroUI-style cards, color-coded badges (green=success, red=danger, cyan=accent, blue=primary, orange=warning).

**Mock data:**
- 4 bots: BTCUSDT (Grid Long, running), ETHUSDT (Grid Long, running), SOLUSDT (DCA, running), XRPUSDT (Grid Short, stopped)
- BTCUSDT expanded: 2 LONG positions, 4 orders (2 ENTRY, 2 TP)
- Live P&L simulation: values increment with flash animation

- [ ] **Step 2: Verify in browser**

Run: `npm run dev` then open `http://localhost:3000/demo.html`

Expected: Animation auto-plays through all 12 scenes in ~26 seconds.

- [ ] **Step 3: Adjust timings if needed**

Watch the full animation. If any transitions feel rushed, increase the `at` values in the timeline array.

- [ ] **Step 4: Commit**

```bash
git add public/demo.html
git commit -m "feat: add animated dashboard demo page for promotional video"
```

---

## Chunk 2: Screen Recording (Manual)

### Task 2: Record the demo as a video

- [ ] **Step 1: Set browser to 1280×720**
- [ ] **Step 2: Record with OBS / SimpleScreenRecorder / native screen recorder**
- [ ] **Step 3: Open demo.html, let animation play through**
- [ ] **Step 4: Trim & export as MP4 (H.264, 720p, 30fps)**

---

## Notes

- Self-contained: no API calls, no database, no auth.
- To re-run: refresh the page.
- To adjust speed: modify `at` values in the `timeline` array (milliseconds).
- Viewport locked to 1280px for consistent recording.
