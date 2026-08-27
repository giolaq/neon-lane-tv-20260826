# Neon Lane TV

Neon Lane TV is a full-screen, three-lane browser game designed for keyboard
and TV remote input.

## Prerequisites

- Node.js 20.19.x, or Node.js 22.12 or newer
- npm
- A WebGL-enabled browser

Run every command below from the repository root.

## Install

Install the exact dependency versions recorded in `package-lock.json`:

```sh
npm ci
```

## Launch

Start the Vite development server:

```sh
npm start
```

Open `http://localhost:5173/`. Stop the server with `Ctrl+C`.

## Controls

The numeric values are supported remote-equivalent `keyCode` inputs.

| Keyboard input | Remote code | Action |
| --- | ---: | --- |
| `ArrowLeft` | `37` | Move one lane left |
| `ArrowRight` | `39` | Move one lane right |
| `Enter` | `13` | Restart after game over |
| `Space` | `32` | Restart after game over |

Held or repeated inputs are ignored.

## Seeded Runs

For a repeatable run, append `?seed=<uint32>` to the launch URL and replace
`<uint32>` with one decimal integer from `0` through `4294967295`, inclusive:

```text
http://localhost:5173/?seed=12345
```

An explicit seed produces the same obstacle sequence and is reused when the
run restarts. A URL without `seed` generates a fresh seed for each run.

## Test And Build

Run the complete test suite:

```sh
npm test
```

Create the production bundle in `dist/`:

```sh
npm run build
```

## Browser Verification

With `npm start` running, open `http://localhost:5173/?seed=1` and verify at
both `1280x720` and `1920x1080`:

1. Gameplay fills the viewport, shows the three lanes, craft, incoming gate,
   and score without clipping or overlap.
2. `ArrowLeft`/`ArrowRight` and remote codes `37`/`39` move the craft one lane.
3. Allow the center-lane collision to occur. The `Game Over` and final score
   text remain visible, centered, and non-overlapping.
4. Press `Enter`, `Space`, remote code `13`, or remote code `32` to restart.
