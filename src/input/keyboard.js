const CONTROLS = [
  { key: "ArrowLeft", keyCode: 37, command: "MOVE_LEFT" },
  { key: "ArrowRight", keyCode: 39, command: "MOVE_RIGHT" },
  { key: "Enter", keyCode: 13, command: "SELECT" },
  { key: " ", keyCode: 32, command: "SELECT" },
];

const CONTROL_BY_KEY = new Map(
  CONTROLS.map((control) => [control.key, control]),
);
const CONTROL_BY_KEY_CODE = new Map(
  CONTROLS.map((control) => [control.keyCode, control]),
);

export function mapKeydown(event) {
  if (
    event === null ||
    typeof event !== "object" ||
    typeof event.preventDefault !== "function"
  ) {
    return undefined;
  }

  if (event.repeat !== undefined && typeof event.repeat !== "boolean") {
    return undefined;
  }

  if (
    (event.key !== undefined && typeof event.key !== "string") ||
    (event.keyCode !== undefined &&
      (typeof event.keyCode !== "number" ||
        !Number.isInteger(event.keyCode)))
  ) {
    return undefined;
  }

  const keyControl = CONTROL_BY_KEY.get(event.key);
  const keyCodeControl = CONTROL_BY_KEY_CODE.get(event.keyCode);

  if (
    keyControl !== undefined &&
    keyCodeControl !== undefined &&
    keyControl !== keyCodeControl
  ) {
    return undefined;
  }

  const control = keyControl ?? keyCodeControl;
  if (control === undefined) {
    return undefined;
  }

  event.preventDefault();
  return event.repeat === true ? undefined : control.command;
}

export function attachInput(target, onCommand) {
  if (
    target === null ||
    typeof target !== "object" ||
    typeof target.addEventListener !== "function" ||
    typeof target.removeEventListener !== "function"
  ) {
    throw new TypeError("target must be an event target");
  }

  if (typeof onCommand !== "function") {
    throw new TypeError("onCommand must be a function");
  }

  const listener = (event) => {
    const command = mapKeydown(event);
    if (command !== undefined) {
      onCommand(command);
    }
  };

  let disposed = false;
  target.addEventListener("keydown", listener);

  return () => {
    if (disposed) {
      return;
    }

    disposed = true;
    target.removeEventListener("keydown", listener);
  };
}
