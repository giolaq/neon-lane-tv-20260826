const COMMAND_BY_KEY = new Map([
  ["ArrowLeft", "MOVE_LEFT"],
  ["ArrowRight", "MOVE_RIGHT"],
  ["Enter", "SELECT"],
  [" ", "SELECT"],
]);

const COMMAND_BY_KEY_CODE = new Map([
  [37, "MOVE_LEFT"],
  [39, "MOVE_RIGHT"],
  [13, "SELECT"],
  [32, "SELECT"],
]);

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

  const command =
    event.key === undefined
      ? COMMAND_BY_KEY_CODE.get(event.keyCode)
      : COMMAND_BY_KEY.get(event.key);

  if (command === undefined) {
    return undefined;
  }

  event.preventDefault();
  return event.repeat === true ? undefined : command;
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
