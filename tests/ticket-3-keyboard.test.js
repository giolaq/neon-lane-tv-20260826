import { suite } from "uvu";
import * as assert from "uvu/assert";

const keyboardModuleUrl = new URL("../src/input/keyboard.js", import.meta.url);
let keyboard = {};

try {
  keyboard = await import(keyboardModuleUrl);
} catch (error) {
  if (
    error?.code !== "ERR_MODULE_NOT_FOUND" ||
    error?.url !== keyboardModuleUrl.href
  ) {
    throw error;
  }
}

const mapKeydown =
  typeof keyboard.mapKeydown === "function"
    ? keyboard.mapKeydown
    : () => undefined;
const attachInput =
  typeof keyboard.attachInput === "function"
    ? keyboard.attachInput
    : () => () => {};

function syntheticEvent(properties = {}) {
  let defaultPreventions = 0;

  return {
    ...properties,
    preventDefault() {
      defaultPreventions += 1;
    },
    get defaultPreventions() {
      return defaultPreventions;
    },
  };
}

class SyntheticEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const acceptedControls = [
  ["ArrowLeft", { key: "ArrowLeft" }, "MOVE_LEFT"],
  ["legacy left", { keyCode: 37 }, "MOVE_LEFT"],
  ["ArrowRight", { key: "ArrowRight" }, "MOVE_RIGHT"],
  ["legacy right", { keyCode: 39 }, "MOVE_RIGHT"],
  ["Enter", { key: "Enter" }, "SELECT"],
  ["legacy enter", { keyCode: 13 }, "SELECT"],
  ["Space", { key: " " }, "SELECT"],
  ["legacy space", { keyCode: 32 }, "SELECT"],
];

const test = suite("ticket #3 keyboard acceptance");

test("exports the public keyboard adapter functions", () => {
  assert.type(
    keyboard.mapKeydown,
    "function",
    "mapKeydown must be exported from src/input/keyboard.js",
  );
  assert.type(
    keyboard.attachInput,
    "function",
    "attachInput must be exported from src/input/keyboard.js",
  );
});

test("maps every approved named and legacy control once", () => {
  for (const [label, properties, expectedCommand] of acceptedControls) {
    const event = syntheticEvent(properties);

    assert.is(mapKeydown(event), expectedCommand, `${label} command`);
    assert.is(
      event.defaultPreventions,
      1,
      `${label} must prevent its browser default exactly once`,
    );
  }
});

test("does not emit commands for repeated accepted controls", () => {
  for (const [label, properties] of acceptedControls) {
    const event = syntheticEvent({ ...properties, repeat: true });

    assert.is(mapKeydown(event), undefined, `${label} repeat`);
  }
});

test("leaves unsupported and malformed inputs unhandled", () => {
  const unhandledInputs = [
    null,
    undefined,
    {},
    "ArrowLeft",
    syntheticEvent({ key: "Escape", keyCode: 27 }),
    syntheticEvent({ key: "Left" }),
    syntheticEvent({ keyCode: "37" }),
    syntheticEvent({ keyCode: Number.NaN }),
    { key: "ArrowLeft", preventDefault: null },
  ];

  for (const input of unhandledInputs) {
    assert.is(mapKeydown(input), undefined);
    if (input && typeof input.preventDefault === "function") {
      assert.is(input.defaultPreventions, 0);
    }
  }
});

test("handles an event represented by both APIs only once", () => {
  const target = new SyntheticEventTarget();
  const commands = [];
  const event = syntheticEvent({ key: "ArrowLeft", keyCode: 37 });
  const dispose = attachInput(target, (command) => commands.push(command));

  target.dispatch("keydown", event);

  assert.equal(commands, ["MOVE_LEFT"]);
  assert.is(event.defaultPreventions, 1);
  dispose();
});

test("forwards accepted commands and suppresses all other events", () => {
  const target = new SyntheticEventTarget();
  const commands = [];
  const dispose = attachInput(target, (command) => commands.push(command));
  const left = syntheticEvent({ key: "ArrowLeft" });
  const repeatedSelect = syntheticEvent({ key: "Enter", repeat: true });
  const unsupported = syntheticEvent({ key: "Escape" });

  assert.type(dispose, "function");
  assert.is(target.listenerCount("keydown"), 1);

  target.dispatch("keydown", left);
  target.dispatch("keydown", repeatedSelect);
  target.dispatch("keydown", unsupported);

  assert.equal(commands, ["MOVE_LEFT"]);
  assert.is(left.defaultPreventions, 1);
  assert.is(unsupported.defaultPreventions, 0);
  dispose();
});

test("returns an idempotent disposer that stops command forwarding", () => {
  const target = new SyntheticEventTarget();
  const commands = [];
  const dispose = attachInput(target, (command) => commands.push(command));

  dispose();
  dispose();
  assert.is(target.listenerCount("keydown"), 0);

  const eventAfterDisposal = syntheticEvent({ key: "ArrowRight" });
  target.dispatch("keydown", eventAfterDisposal);

  assert.equal(commands, []);
  assert.is(eventAfterDisposal.defaultPreventions, 0);
});

test.run();
