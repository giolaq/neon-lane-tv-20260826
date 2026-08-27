import styles from "./styles.css?inline";

import { createGame } from "./game/core.js";
import { isUint32 } from "./game/random.js";
import { attachInput } from "./input/keyboard.js";
import { createHud, renderHud } from "./render/hud.js";
import {
  createScene,
  renderScene,
  resizeScene,
} from "./render/scene.js";

const EXPLICIT = "EXPLICIT";
const GENERATED = "GENERATED";
const ACTIVE = "ACTIVE";
const GAME_OVER = "GAME_OVER";
const SELECT = "SELECT";
const DECIMAL_SEED = /^\d+$/;

export function parseSeed(search) {
  const parameters = new URLSearchParams(search);
  const values = parameters.getAll("seed");

  if (values.length === 0) {
    return null;
  }
  if (values.length !== 1 || !DECIMAL_SEED.test(values[0])) {
    throw new RangeError("seed query must contain one uint32 decimal value");
  }

  const seed = Number(values[0]);
  if (!isUint32(seed)) {
    throw new RangeError("seed query must contain one uint32 decimal value");
  }
  return seed;
}

export function generateSeed(randomSource = globalThis.crypto) {
  if (
    !randomSource ||
    typeof randomSource.getRandomValues !== "function"
  ) {
    throw new TypeError("a cryptographic uint32 seed source is required");
  }

  const values = new Uint32Array(1);
  randomSource.getRandomValues(values);
  return values[0];
}

export function bootstrap({
  windowObject = window,
  documentObject = document,
  randomSource = windowObject.crypto,
} = {}) {
  const explicitSeed = parseSeed(windowObject.location.search);
  const seedMode = explicitSeed === null ? GENERATED : EXPLICIT;
  const initialSeed =
    seedMode === GENERATED ? generateSeed(randomSource) : explicitSeed;
  const game = createGame({ seed: initialSeed, seedMode });
  const stylesheet = documentObject.createElement("style");
  stylesheet.textContent = styles;
  documentObject.head.append(stylesheet);
  const scene = createScene(documentObject.body);
  const hud = createHud(documentObject.body);

  let frameRequest = null;
  let previousTimestamp = null;

  function render(snapshot = game.getSnapshot()) {
    renderScene(scene, snapshot);
    renderHud(hud, snapshot);
    return snapshot;
  }

  function scheduleFrame() {
    if (frameRequest === null) {
      frameRequest = windowObject.requestAnimationFrame(animationFrame);
    }
  }

  function animationFrame(timestamp) {
    frameRequest = null;
    const delta =
      previousTimestamp === null ? 0 : (timestamp - previousTimestamp) / 1000;
    previousTimestamp = timestamp;

    const snapshot = render(game.advanceGame(delta));
    if (snapshot.status === ACTIVE) {
      scheduleFrame();
    }
  }

  function handleCommand(command) {
    const current = game.getSnapshot();
    if (current.status === GAME_OVER && command !== SELECT) {
      return current;
    }

    const freshSeed =
      current.status === GAME_OVER &&
      command === SELECT &&
      seedMode === GENERATED
        ? generateSeed(randomSource)
        : undefined;
    const snapshot = game.applyCommand(command, freshSeed);

    if (current.status === GAME_OVER && snapshot.status === ACTIVE) {
      previousTimestamp = null;
      render(snapshot);
      scheduleFrame();
      return snapshot;
    }

    if (snapshot !== current) {
      render(snapshot);
    }
    return snapshot;
  }

  function handleResize() {
    resizeScene(scene, windowObject.innerWidth, windowObject.innerHeight);
    render();
  }

  const detachInput = attachInput(windowObject, handleCommand);
  windowObject.addEventListener("resize", handleResize);
  handleResize();
  scheduleFrame();

  return Object.freeze({
    game,
    scene,
    hud,
    handleCommand,
    destroy() {
      detachInput();
      windowObject.removeEventListener("resize", handleResize);
      if (frameRequest !== null) {
        windowObject.cancelAnimationFrame(frameRequest);
        frameRequest = null;
      }
    },
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootstrap();
}
