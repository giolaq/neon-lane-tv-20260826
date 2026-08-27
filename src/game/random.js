const UINT32_MAX = 0xffffffff;
const UINT32_INCREMENT = 0x6d2b79f5;

function assertUint32(value, label = "seed") {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} must be a uint32`);
  }
}

export function createRandomState(seed) {
  assertUint32(seed);
  return { value: seed };
}

export function nextRandomUint32(randomState) {
  if (!randomState || typeof randomState !== "object") {
    throw new TypeError("randomState must be an object");
  }

  assertUint32(randomState.value, "randomState.value");

  randomState.value = (randomState.value + UINT32_INCREMENT) >>> 0;

  let value = randomState.value;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return (value ^ (value >>> 14)) >>> 0;
}

export function isUint32(value) {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= UINT32_MAX
  );
}
