import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { suite } from "uvu";
import * as assert from "uvu/assert";
import { createServer } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const REQUIRED_FILES = [
  "index.html",
  "src/main.js",
  "src/render/scene.js",
  "src/render/hud.js",
  "src/styles.css",
];
const UINT32_MAX = 0xffffffff;
const test = suite("ticket #4 playable TV acceptance");

const missingFiles = REQUIRED_FILES.filter(
  (relativePath) => !existsSync(resolve(ROOT, relativePath)),
);

test("provides the complete browser application surface", () => {
  assert.equal(
    missingFiles,
    [],
    `missing Ticket #4 application files: ${missingFiles.join(", ")}`,
  );
});

function sleep(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(`${pending.method}: ${message.error.message}`),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await withTimeout(
      new Promise((resolvePromise, reject) => {
        socket.addEventListener("open", resolvePromise, { once: true });
        socket.addEventListener("error", reject, { once: true });
      }),
      5_000,
      "CDP websocket connection",
    );
    return new CdpSession(socket);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;

    const result = new Promise((resolvePromise, reject) => {
      this.pending.set(id, { method, resolve: resolvePromise, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return withTimeout(result, 10_000, method);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  waitForEvent(method) {
    return withTimeout(
      new Promise((resolvePromise) => {
        const dispose = this.on(method, (params) => {
          dispose();
          resolvePromise(params);
        });
      }),
      10_000,
      method,
    );
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text;
      throw new Error(`browser evaluation failed: ${description}`);
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find(existsSync);
}

async function launchChrome() {
  const executable = chromeExecutable();
  assert.type(
    executable,
    "string",
    "headless Chrome is required for Ticket #4 browser acceptance",
  );

  const profile = await mkdtemp(join(tmpdir(), "ticket-4-chrome-"));
  const process = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let diagnostics = "";
  const webSocketUrl = await withTimeout(
    new Promise((resolvePromise, reject) => {
      process.stderr.setEncoding("utf8");
      process.stderr.on("data", (chunk) => {
        diagnostics = `${diagnostics}${chunk}`.slice(-4_000);
        const match = diagnostics.match(
          /DevTools listening on (ws:\/\/[^\s]+)/,
        );
        if (match) {
          resolvePromise(match[1]);
        }
      });
      process.once("exit", (code) => {
        reject(
          new Error(
            `headless Chrome exited with ${code}\n${diagnostics.slice(-2_000)}`,
          ),
        );
      });
      process.once("error", reject);
    }),
    10_000,
    "headless Chrome launch",
  );

  return {
    debugOrigin: new URL(webSocketUrl).origin.replace("ws:", "http:"),
    process,
    profile,
    async close() {
      if (process.exitCode === null) {
        process.kill("SIGTERM");
        await withTimeout(
          new Promise((resolvePromise) => {
            process.once("exit", resolvePromise);
          }),
          5_000,
          "headless Chrome shutdown",
        ).catch(() => process.kill("SIGKILL"));
      }
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function createBrowserPage(chrome) {
  const response = await fetch(`${chrome.debugOrigin}/json/new?about:blank`, {
    method: "PUT",
  });
  assert.is(response.status, 200, "Chrome must create an acceptance-test tab");
  const target = await response.json();
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  const exceptions = [];

  await Promise.all([
    session.send("Page.enable"),
    session.send("Runtime.enable"),
  ]);
  session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    exceptions.push(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  });
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      (() => {
        const seeds = [1, 3, 0, 5];
        window.__ticket4SeedCalls = [];
        Object.defineProperty(window.crypto, "getRandomValues", {
          configurable: true,
          value(array) {
            const value = seeds[window.__ticket4SeedCalls.length] ?? 7;
            window.__ticket4SeedCalls.push(value);
            array.fill(0);
            array[0] = value;
            return array;
          },
        });
      })();
    `,
  });

  return { exceptions, session };
}

async function setViewport(session, width, height) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function navigate(page, url, width = 1280, height = 720) {
  page.exceptions.length = 0;
  await setViewport(page.session, width, height);
  const loaded = page.session.waitForEvent("Page.loadEventFired");
  await page.session.send("Page.navigate", { url });
  await loaded;
  await waitFor(
    page.session,
    "document.readyState === 'complete'",
    "document completion",
  );
  await sleep(50);
}

async function waitFor(session, expression, label, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await session.evaluate(expression);
    if (lastValue) {
      return lastValue;
    }
    await sleep(20);
  }
  throw new Error(`${label} was not observed; last value: ${lastValue}`);
}

function keyExpression({ key, keyCode, repeat = false }) {
  return `
    (() => {
      const event = new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key ?? "")},
        repeat: ${repeat},
        bubbles: true,
        cancelable: true,
      });
      ${
        keyCode === undefined
          ? ""
          : `Object.defineProperty(event, "keyCode", { value: ${keyCode} });`
      }
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })()
  `;
}

async function captureAnalysis(session) {
  const { data } = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  assert.ok(data.length > 1_000, "the browser screenshot must not be blank");

  return session.evaluate(`
    (async () => {
      const image = new Image();
      image.src = "data:image/png;base64,${data}";
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      let cyan = 0;
      let cyanX = 0;
      let cyanY = 0;
      let gate = 0;
      const colors = new Set();

      for (let index = 0; index < pixels.length; index += 16) {
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const maximum = Math.max(r, g, b);
        const minimum = Math.min(r, g, b);
        if (maximum - minimum > 18 || maximum > 45) {
          colored += 1;
        }
        colors.add(\`\${r >> 4},\${g >> 4},\${b >> 4}\`);

        const pixel = index / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        if (
          y > canvas.height * 0.5 &&
          g > 75 &&
          b > 75 &&
          g > r * 1.35 &&
          b > r * 1.25
        ) {
          cyan += 1;
          cyanX += x;
          cyanY += y;
        }
        const magenta = r > 85 && b > 65 && r > g * 1.35 && b > g * 1.2;
        const amber = r > 100 && g > 50 && r > b * 1.8 && g > b * 1.3;
        if (magenta || amber) {
          gate += 1;
        }
      }

      return {
        width: canvas.width,
        height: canvas.height,
        colored,
        distinctColors: colors.size,
        cyan,
        cyanX: cyan === 0 ? null : cyanX / cyan,
        cyanY: cyan === 0 ? null : cyanY / cyan,
        gate,
      };
    })()
  `);
}

function hudInspectionExpression(expectedWidth, expectedHeight) {
  return `
    (() => {
      const normalize = (value) => value.replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      };
      const candidates = [...document.querySelectorAll("body *")].filter(visible);
      const smallestMatch = (pattern) => candidates
        .filter((element) => pattern.test(normalize(element.innerText)))
        .sort((left, right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return a.width * a.height - b.width * b.height;
        })[0];
      const score = smallestMatch(/^Score\\s*:?\\s*\\d+$/i);
      if (!score) {
        return { issue: "visible score text is missing" };
      }
      const rect = score.getBoundingClientRect();
      const style = getComputedStyle(score);
      const color = style.color.match(/[\\d.]+/g)?.map(Number) ?? [];
      const semantic = score.closest("output, [role='status'], [aria-live]") ??
        score.querySelector("output, [role='status'], [aria-live]");
      const panelStyle = getComputedStyle(semantic ?? score);

      return {
        viewport: [innerWidth, innerHeight],
        expectedViewport: [${expectedWidth}, ${expectedHeight}],
        text: normalize(score.innerText),
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
        color,
        semantic: Boolean(semantic),
        panel: {
          background: panelStyle.backgroundColor,
          border: panelStyle.borderStyle,
          shadow: panelStyle.boxShadow,
        },
      };
    })()
  `;
}

function assertSafeHud(hud, width, height) {
  assert.not.ok(hud.issue, hud.issue);
  assert.equal(hud.viewport, [width, height]);
  assert.equal(hud.expectedViewport, [width, height]);
  assert.ok(hud.semantic, "score must belong to a semantic live/status element");
  assert.ok(
    hud.color.slice(0, 3).every((channel) => channel >= 235),
    `score must be high-contrast white, received ${hud.color.join(",")}`,
  );

  const horizontalMargin = width * 0.05;
  const verticalMargin = height * 0.05;
  assert.ok(hud.rect.left >= horizontalMargin, "HUD clips the left safe margin");
  assert.ok(hud.rect.right <= width - horizontalMargin, "HUD clips the right safe margin");
  assert.ok(hud.rect.top >= verticalMargin, "HUD clips the top safe margin");
  assert.ok(hud.rect.bottom <= height - verticalMargin, "HUD clips the bottom safe margin");
  assert.ok(
    hud.panel.background === "rgba(0, 0, 0, 0)" ||
      hud.panel.background === "transparent",
    "the HUD must not be placed in a decorative panel",
  );
  assert.is(hud.panel.border, "none", "the HUD must not have a panel border");
  assert.is(hud.panel.shadow, "none", "the HUD must not have a panel shadow");
}

function gameOverInspectionExpression() {
  return `
    (() => {
      const normalize = (value) => value.replace(/\\s+/g, " ").trim();
      const visible = [...document.querySelectorAll("body *")].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
          style.visibility !== "hidden";
      });
      const smallest = (predicate) => visible
        .filter((element) => predicate(normalize(element.innerText)))
        .sort((left, right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return a.width * a.height - b.width * b.height;
        })[0];
      const label = smallest((text) => text === "Game Over");
      const finalScore = smallest(
        (text) => /^(?:Final\\s+)?Score\\s*:?\\s*\\d+$/i.test(text)
      );
      const rectangle = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      return {
        label: label ? normalize(label.innerText) : null,
        finalText: finalScore ? normalize(finalScore.innerText) : null,
        labelRect: rectangle(label),
        finalRect: rectangle(finalScore),
      };
    })()
  `;
}

function rectanglesOverlap(first, second) {
  return !(
    first.right <= second.left ||
    second.right <= first.left ||
    first.bottom <= second.top ||
    second.bottom <= first.top
  );
}

function assertSafeRect(rect, width, height, label) {
  assert.ok(rect, `${label} must have a visible bounding box`);
  assert.ok(rect.left >= width * 0.05, `${label} clips the left safe margin`);
  assert.ok(rect.right <= width * 0.95, `${label} clips the right safe margin`);
  assert.ok(rect.top >= height * 0.05, `${label} clips the top safe margin`);
  assert.ok(rect.bottom <= height * 0.95, `${label} clips the bottom safe margin`);
}

if (missingFiles.length === 0) {
  let vite;
  let chrome;
  let page;
  let baseUrl;

  test.before(async () => {
    vite = await createServer({
      root: ROOT,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    chrome = await launchChrome();
    page = await createBrowserPage(chrome);
  });

  test.after(async () => {
    page?.session.close();
    await chrome?.close();
    await vite?.close();
  });

  test("uses the approved Three.js, geometry, lighting, and renderer contracts", async () => {
    const sceneSource = readFileSync(resolve(ROOT, "src/render/scene.js"), "utf8");
    assert.match(sceneSource, /from\s+["']three["']/);
    assert.match(sceneSource, /\bPerspectiveCamera\b/);
    assert.match(
      sceneSource,
      /\b(?:Ambient|Directional|Hemisphere|Point|Spot)Light\b/,
    );
    assert.match(
      sceneSource,
      /\b(?:Buffer|Shape|Extrude)Geometry\b/,
      "the scene must include custom geometry, not only primitive meshes",
    );

    await navigate(page, `${baseUrl}/?seed=12345`);
    const contracts = await page.session.evaluate(`
      Promise.all([
        import("/src/render/scene.js"),
        import("/src/render/hud.js"),
      ]).then(([scene, hud]) => ({
        scene: ["createScene", "renderScene", "resizeScene"]
          .filter((name) => typeof scene[name] !== "function"),
        hud: ["createHud", "renderHud"]
          .filter((name) => typeof hud[name] !== "function"),
      }))
    `);
    assert.equal(contracts, { scene: [], hud: [] });
    assert.equal(page.exceptions, [], "a valid explicit seed must launch cleanly");
  });

  test("launches directly into a full-viewport active Three.js game", async () => {
    await navigate(page, `${baseUrl}/?seed=5`);
    const dom = await page.session.evaluate(`
      (() => {
        const canvas = document.querySelector("canvas");
        const rect = canvas?.getBoundingClientRect();
        const controls = document.querySelectorAll(
          "button, input, select, textarea, nav, dialog, [role='button']"
        );
        return {
          canvasCount: document.querySelectorAll("canvas").length,
          canvasRect: rect && {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          controls: controls.length,
          text: document.body.innerText,
          scrollSize: [
            document.scrollingElement.scrollWidth,
            document.scrollingElement.scrollHeight,
          ],
        };
      })()
    `);
    assert.is(dom.canvasCount, 1, "gameplay must use one full-viewport canvas");
    assert.equal(dom.canvasRect, { left: 0, top: 0, width: 1280, height: 720 });
    assert.is(dom.controls, 0, "launch must not expose menus or interactive panels");
    assert.not.match(dom.text, /\b(?:tutorial|settings|touch|start game)\b/i);
    assert.equal(dom.scrollSize, [1280, 720], "full-screen play must not scroll");

    const pixels = await captureAnalysis(page.session);
    assert.equal([pixels.width, pixels.height], [1280, 720]);
    assert.ok(pixels.colored > 5_000, "the Three.js frame must be visibly nonblank");
    assert.ok(pixels.distinctColors > 40, "lighting and perspective must shade the scene");
    assert.ok(pixels.cyan > 40, "the frame must contain a visible cyan craft");
    assert.ok(pixels.gate > 40, "the frame must contain a magenta or amber gate");
    assert.ok(
      pixels.cyanY > pixels.height * 0.55,
      "the cyan craft must remain near the bottom of the viewport",
    );
  });

  test("moves one lane for named and legacy keys and suppresses repeats", async () => {
    await navigate(page, `${baseUrl}/?seed=5`);
    const centered = await captureAnalysis(page.session);

    assert.ok(
      await page.session.evaluate(keyExpression({ key: "ArrowRight" })),
      "named directional controls must prevent their browser default",
    );
    await sleep(40);
    const right = await captureAnalysis(page.session);
    assert.ok(
      right.cyanX > centered.cyanX + 80,
      "ArrowRight must move the craft exactly one visible lane",
    );

    assert.ok(
      await page.session.evaluate(
        keyExpression({ key: "ArrowLeft", repeat: true }),
      ),
      "accepted repeated controls must still prevent their browser default",
    );
    await sleep(40);
    const afterRepeat = await captureAnalysis(page.session);
    assert.ok(
      Math.abs(afterRepeat.cyanX - right.cyanX) < 8,
      "a repeated key event must not move the craft",
    );

    assert.ok(
      await page.session.evaluate(keyExpression({ keyCode: 37 })),
      "legacy directional controls must prevent their browser default",
    );
    await sleep(40);
    const legacyLeft = await captureAnalysis(page.session);
    assert.ok(
      Math.abs(legacyLeft.cyanX - centered.cyanX) < 12,
      "legacy left must move back by one lane",
    );

    await navigate(page, `${baseUrl}/?seed=0`);
    const freshCenter = await captureAnalysis(page.session);
    await page.session.evaluate(keyExpression({ key: "ArrowLeft" }));
    await sleep(40);
    const left = await captureAnalysis(page.session);
    assert.ok(
      left.cyanX < freshCenter.cyanX - 80,
      "ArrowLeft must expose the third visible craft lane",
    );
    await page.session.evaluate(keyExpression({ keyCode: 39 }));
    await sleep(40);
    const legacyRight = await captureAnalysis(page.session);
    assert.ok(
      Math.abs(legacyRight.cyanX - freshCenter.cyanX) < 12,
      "legacy right must move back by one lane",
    );
  });

  test("scores, collides, freezes, ignores movement, and instantly restarts", async () => {
    await navigate(page, `${baseUrl}/?seed=0`);
    await waitFor(
      page.session,
      "/^Score\\s*:?\\s*1$/im.test(document.body.innerText)",
      "first safe-gate score",
      2_000,
    );

    await navigate(page, `${baseUrl}/?seed=1`);
    await waitFor(
      page.session,
      "document.body.innerText.includes('Game Over')",
      "same-lane collision",
      2_000,
    );
    const gameOver = await page.session.evaluate(gameOverInspectionExpression());
    assert.is(gameOver.label, "Game Over");
    assert.match(gameOver.finalText, /^(?:Final\s+)?Score\s*:?\s*0$/i);
    assert.not.ok(
      rectanglesOverlap(gameOver.labelRect, gameOver.finalRect),
      "Game Over and final score must not overlap",
    );

    const frozen = (await page.session.send("Page.captureScreenshot")).data;
    await page.session.evaluate(keyExpression({ key: "ArrowLeft" }));
    await page.session.evaluate(keyExpression({ keyCode: 39 }));
    await sleep(150);
    const afterMovement = (await page.session.send("Page.captureScreenshot")).data;
    assert.is(
      afterMovement,
      frozen,
      "the complete rendered frame must freeze and ignore movement after collision",
    );

    await page.session.evaluate(keyExpression({ key: "Enter" }));
    await waitFor(
      page.session,
      "!document.body.innerText.includes('Game Over') && /^Score\\s*:?\\s*0$/im.test(document.body.innerText)",
      "instant Enter restart",
      500,
    );
    assert.equal(
      await page.session.evaluate("window.__ticket4SeedCalls"),
      [],
      "an explicit-seed restart must reuse its seed without generating another",
    );
  });

  test("accepts uint32 query seeds and rejects every invalid query shape", async () => {
    for (const seed of [0, 12345, UINT32_MAX]) {
      await navigate(page, `${baseUrl}/?seed=${seed}`);
      assert.is(
        await page.session.evaluate("document.querySelectorAll('canvas').length"),
        1,
        `seed ${seed} must launch`,
      );
      assert.equal(
        await page.session.evaluate("window.__ticket4SeedCalls"),
        [],
        `seed ${seed} must be treated as explicit`,
      );
    }

    const invalidQueries = [
      "?seed=",
      "?seed=abc",
      "?seed=-1",
      "?seed=1.5",
      "?seed=4294967296",
      "?seed=1e3",
      "?seed=%2B1",
      "?seed=%201",
      "?seed=1&seed=2",
      "?seed=1&seed=1",
    ];
    for (const query of invalidQueries) {
      await navigate(page, `${baseUrl}/${query}`);
      assert.is(
        await page.session.evaluate("document.querySelectorAll('canvas').length"),
        0,
        `${query} must fail before gameplay launches`,
      );
      assert.equal(
        await page.session.evaluate("window.__ticket4SeedCalls"),
        [],
        `${query} must not silently fall back to an unseeded run`,
      );
    }
  });

  test("generates a fresh uint32 seed for initial and repeated unseeded runs", async () => {
    await navigate(page, `${baseUrl}/`);
    assert.equal(await page.session.evaluate("window.__ticket4SeedCalls"), [1]);
    await waitFor(
      page.session,
      "document.body.innerText.includes('Game Over')",
      "first generated-seed collision",
      2_000,
    );

    await page.session.evaluate(keyExpression({ key: "Enter" }));
    await waitFor(
      page.session,
      "!document.body.innerText.includes('Game Over')",
      "generated Enter restart",
      500,
    );
    assert.equal(await page.session.evaluate("window.__ticket4SeedCalls"), [1, 3]);
    await waitFor(
      page.session,
      "document.body.innerText.includes('Game Over')",
      "second generated-seed collision",
      2_000,
    );

    await page.session.evaluate(keyExpression({ key: " " }));
    await waitFor(
      page.session,
      "!document.body.innerText.includes('Game Over')",
      "generated Space restart",
      500,
    );
    assert.equal(
      await page.session.evaluate("window.__ticket4SeedCalls"),
      [1, 3, 0],
      "each unseeded run must request and use a new uint32 seed",
    );
  });

  test("preserves safe HUD margins and scene composition at both TV sizes", async () => {
    const viewports = [
      [1280, 720],
      [1920, 1080],
    ];
    await navigate(page, `${baseUrl}/?seed=12345`, 1280, 720);

    for (let index = 0; index < viewports.length; index += 1) {
      const [width, height] = viewports[index];
      if (index > 0) {
        await setViewport(page.session, width, height);
        await page.session.evaluate("window.dispatchEvent(new Event('resize'))");
        await sleep(100);
      }

      const canvas = await page.session.evaluate(`
        (() => {
          const element = document.querySelector("canvas");
          const rect = element.getBoundingClientRect();
          return {
            css: [rect.left, rect.top, rect.width, rect.height],
            buffer: [element.width, element.height],
          };
        })()
      `);
      assert.equal(canvas.css, [0, 0, width, height]);
      assert.equal(canvas.buffer, [width, height]);

      const hud = await page.session.evaluate(
        hudInspectionExpression(width, height),
      );
      assertSafeHud(hud, width, height);

      const pixels = await captureAnalysis(page.session);
      assert.ok(pixels.cyan > 40, `${width}x${height} must retain the cyan craft`);
      assert.ok(pixels.gate > 40, `${width}x${height} must retain colored gates`);
      assert.ok(
        Math.abs(pixels.cyanX / width - 0.5) < 0.08,
        `${width}x${height} must retain centered player placement`,
      );
      assert.ok(
        pixels.cyanY / height > 0.55 && pixels.cyanY / height < 0.95,
        `${width}x${height} must retain bottom player placement`,
      );
      assert.equal(page.exceptions, [], `${width}x${height} must render cleanly`);
    }

    for (const [width, height] of viewports) {
      await navigate(page, `${baseUrl}/?seed=1`, width, height);
      await waitFor(
        page.session,
        "document.body.innerText.includes('Game Over')",
        `${width}x${height} game-over collision`,
        2_000,
      );
      const gameOver = await page.session.evaluate(gameOverInspectionExpression());
      assertSafeRect(gameOver.labelRect, width, height, "Game Over label");
      assertSafeRect(gameOver.finalRect, width, height, "final score");
      assert.not.ok(
        rectanglesOverlap(gameOver.labelRect, gameOver.finalRect),
        `${width}x${height} game-over content must not overlap`,
      );
      const pixels = await captureAnalysis(page.session);
      assert.ok(
        pixels.colored > 5_000,
        `${width}x${height} frozen scene must remain visibly nonblank`,
      );
    }
  });
}

test.run();
