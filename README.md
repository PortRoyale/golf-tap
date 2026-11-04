# golf-tap (Pattern)

Golf practice scoring for a home simulator. It sits between your launch monitor and GSPro, keeps a copy of every shot, and turns them into one number per club that means the same thing at every distance, for every player, for years.

- **A guided practice session.** "7 iron, 10 shots, to 156" and then the next club. It finds your real carry numbers first, then ranks your clubs and tells you which one to practice.
- **The range in 3D.** Each shot flies out, curves, lands on your dispersion pattern and is added to it, with ball speed, launch, spin, spin axis, carry, total, offline, apex and descent.
- **History to scale.** Your score and your shot pattern over weeks and months, drawn as a terrain: a narrow, bright ridge is a consistent day.
- **Everything recorded.** Every byte from the launch monitor and GSPro goes to a capture file, so nothing is lost if a field turns out to matter later.
- **No scrolling, full screen.** Every screen fits the window. Press F (or the button at top right) for full screen; Esc leaves it.

## Download and run (Windows)

1. Download `golf-tap.exe` from the [latest release](https://github.com/PortRoyale/golf-tap/releases/latest).
2. Put it in its own folder (its data is kept next to it) and double-click it. The app opens in its own window.
3. In your launch monitor's GSPro connector, change the port from **921** to **9211** and connect. Shots still reach GSPro exactly as before.
4. Hit one ball. Pattern reads GSPro's result from its own database (`GSPro.db`, the `LastShot` row) and works out whether GSPro is showing yards or metres by comparing its ball speed with the launch monitor's.

When a new version is published, an **Update** button appears in the top bar. It downloads the new release, checks its SHA-256, swaps the program and restarts. Your data stays where it is.

macOS and Linux builds are on the same release page (`golf-tap-macos-arm64`, `golf-tap-macos-x64`, `golf-tap-linux-x64`).

## Try it without a launch monitor

Click **Try it with pretend shots** (on the first setup screen, the Practice screen, or the Debug page), or run `golf-tap.exe --demo`. A second copy opens with a pretend launch monitor and a pretend GSPro, its own data folder (`demo-data`, wiped each time) and a yellow bar of buttons that swing for you: **Hit a shot**, **Hit 5**, **Push one right** (for the direction step), and **Add six weeks of history** once you're set up. Your real data is never touched.

## How the score works

For one club, target and shot shape, each shot is scored on **where it stops**: GSPro's total distance, with the sideways part of the roll following the direction the ball was travelling when it landed. Golf is played to where the ball ends up. You can switch to where it lands on the Bag page. Alongside the score: how many finished inside 10 and 20 feet (irons and wedges), or in the fairway (driver and woods, fairway width set on the Bag page). If GSPro's roll-out for a club changes between sessions (a firmness setting, a new version), Pattern says so, because scores on where it stops are only comparable on the same ground. Find my real numbers learns both numbers for every club (how far it carries, and where it usually stops), and targets are set where the club usually stops.


- **Miss ratio** Π = RMS distance from the target ÷ target distance. It has no units, so a wedge to 50 and a 6 iron to 180 are on the same scale.
- **Score** = 1000 − 100 · log₂(Π / 0.05). A 5% miss is 1000, and every 100 points halves the miss. There's no ceiling.
- The miss splits exactly into **aim** (where the pattern is centered) and **strike** (how spread out it is).
- Every score carries its own uncertainty. Clubs are only called different when the difference beats the noise, and a trend over time has to beat the session-to-session noise too.
- The algorithm is versioned (`ALGO_VERSION` in `engine.ts`) and frozen, so a score from today means the same thing next year.

`engine.test.ts` checks the statistics by simulation: interval coverage, false-positive rates, power, drift recovery and the exact aim/strike split.

## Physics

GSPro is the authority on where the ball lands. In the background, `physics.ts` fits its own ball-flight model to what GSPro reports: a point mass with Magnus lift and spin decay, three candidate drag and lift shapes, with the shape chosen by cross-validation. Each fit is checked to see whether it has identified its coefficients. A fit is only used once it would leave every score where GSPro put it (|ΔR| < 0.25·RD on at least 95% of sets). It also watches for GSPro's physics changing under you. The 3D flight uses this model's shape, stretched so that it lands exactly where GSPro said.

## Files next to the program

| File | What it is |
| --- | --- |
| `sqe.db` | Every shot, label, session and physics fit (SQLite). Raw messages are kept unmodified. |
| `captures/tap-*.ndjson` | Every byte seen on the wire, GSPro database rows and log lines. |
| `sqe-config.json` | Players, bags, setup and the current plan. |

## Build from source

Requires Node 22.18+ (runs TypeScript directly) or Bun.

```sh
node --no-warnings build-ui.ts                       # embeds ui/app.html and fonts into ui.gen.ts
node --no-warnings tap.ts                            # run from source; open http://localhost:8080
node --no-warnings tap.ts --demo                     # the demo, on http://localhost:8090
node --no-warnings --test engine.test.ts physics.test.ts
bash e2e/run-demo.sh /tmp/demo                       # full walk with screenshots and a no-scroll check
bun build tap.ts --compile --target=bun-windows-x64 --outfile golf-tap.exe
```

Releases are built by `.github/workflows/release.yml`: every push to main is tested and built, and when `APP_VERSION` in `tap.ts` names a version with no release yet, it is published as that release.

## Fonts

Inter and Lora are embedded under the SIL Open Font License 1.1 (`fonts/*-OFL.txt`). On Windows, numbers use Bahnschrift when it's installed.
