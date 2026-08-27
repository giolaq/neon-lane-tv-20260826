import { test } from "uvu";
import * as assert from "uvu/assert";

const CORE_MODULE = "../src/game/core.js";
const RANDOM_MODULE = "../src/game/random.js";

async function loadModule(path) {
  try {
    return { module: await import(path), error: null };
  } catch (error) {
    return { module: null, error };
  }
}

const [coreResult, randomResult] = await Promise.all([
  loadModule(CORE_MODULE),
  loadModule(RANDOM_MODULE),
]);

const requiredCoreExports = [
  "createGame",
  "normalizeDelta",
  "speedForScore",
  "segmentIntersectsCollisionZone",
];
const requiredRandomExports = [
  "createRandomState",
  "nextRandomUint32",
];

function moduleIssue(label, result, requiredExports) {
  if (result.error) {
    return `${label} must load: ${result.error.message}`;
  }

  const missing = requiredExports.filter(
    (name) => typeof result.module[name] !== "function",
  );
  return missing.length === 0
    ? null
    : `${label} must export functions: ${missing.join(", ")}`;
}

const contractIssues = [
  moduleIssue(CORE_MODULE, coreResult, requiredCoreExports),
  moduleIssue(RANDOM_MODULE, randomResult, requiredRandomExports),
].filter(Boolean);

test("exposes the browser-independent game and random contracts", () => {
  assert.equal(contractIssues, []);
});

if (contractIssues.length === 0) {
  const {
    createGame,
    normalizeDelta,
    speedForScore,
    segmentIntersectsCollisionZone,
  } = coreResult.module;
  const {
    createRandomState,
    nextRandomUint32,
  } = randomResult.module;

  const LANES = ["LEFT", "CENTER", "RIGHT"];
  const UINT32_MAX = 0xffffffff;
  const DELTA_LIMIT = 0.05;
  const COLLISION_START = 5.5;
  const COLLISION_END = 6.5;

  function createSeededGame(seed, seedMode = "EXPLICIT") {
    const game = createGame({ seed, seedMode });
    for (const method of [
      "applyCommand",
      "advanceGame",
      "restartGame",
      "getSnapshot",
    ]) {
      assert.type(game?.[method], "function", `controller must expose ${method}`);
    }
    return game;
  }

  function stateOf(game) {
    const snapshot = game.getSnapshot();
    assert.ok(snapshot && typeof snapshot === "object", "snapshot must be an object");
    assert.ok(Array.isArray(snapshot.obstacles), "snapshot must contain obstacles");
    return snapshot;
  }

  function obstacleAt(game, index = 0) {
    const state = stateOf(game);
    assert.ok(
      state.obstacles[index],
      `expected generated obstacle at index ${index}`,
    );
    return { state, obstacle: state.obstacles[index] };
  }

  function moveToLane(game, targetLane) {
    let state = stateOf(game);
    let currentIndex = LANES.indexOf(state.playerLane);
    const targetIndex = LANES.indexOf(targetLane);
    assert.ok(currentIndex >= 0 && targetIndex >= 0, "lanes must use the Lane enum");

    while (currentIndex > targetIndex) {
      game.applyCommand("MOVE_LEFT");
      state = stateOf(game);
      currentIndex = LANES.indexOf(state.playerLane);
    }
    while (currentIndex < targetIndex) {
      game.applyCommand("MOVE_RIGHT");
      state = stateOf(game);
      currentIndex = LANES.indexOf(state.playerLane);
    }
    assert.is(state.playerLane, targetLane);
  }

  function safeLaneFor(blockedLane) {
    return blockedLane === "LEFT" ? "CENTER" : "LEFT";
  }

  function advanceObstacleTo(game, targetZ, laneMode) {
    let current = obstacleAt(game);

    if (laneMode === "safe") {
      moveToLane(game, safeLaneFor(current.obstacle.blockedLane));
    } else if (laneMode === "same") {
      moveToLane(game, current.obstacle.blockedLane);
    }

    for (let step = 0; step < 20_000; step += 1) {
      current = obstacleAt(game);
      const remaining = targetZ - current.obstacle.z;
      if (remaining <= current.state.speed * DELTA_LIMIT) {
        assert.ok(remaining >= 0, `obstacle passed target z=${targetZ}`);
        game.advanceGame(remaining / current.state.speed);
        return obstacleAt(game);
      }

      const previousZ = current.obstacle.z;
      game.advanceGame(DELTA_LIMIT);
      const next = obstacleAt(game);
      assert.ok(
        next.obstacle.z > previousZ,
        "an active obstacle must progress toward increasing z",
      );
      assert.is(next.state.status, "ACTIVE");
    }

    assert.unreachable(`obstacle did not reach z=${targetZ}`);
  }

  function chooseSafeLane(state) {
    const maximumProgress = state.speed * DELTA_LIMIT;
    const dangerousLanes = new Set(
      state.obstacles
        .filter(
          (obstacle) =>
            obstacle.z <= COLLISION_END &&
            obstacle.z + maximumProgress >= COLLISION_START,
        )
        .map((obstacle) => obstacle.blockedLane),
    );
    return LANES.find((lane) => !dangerousLanes.has(lane));
  }

  function advanceEqualRunsSafely(first, second, targetScore) {
    for (let step = 0; step < 30_000; step += 1) {
      const firstState = stateOf(first);
      const secondState = stateOf(second);
      assert.equal(firstState, secondState, "equal seeds must remain deterministic");

      if (firstState.score >= targetScore) {
        return firstState;
      }

      const safeLane = chooseSafeLane(firstState);
      assert.type(safeLane, "string", "a generated gate must leave a safe lane");
      moveToLane(first, safeLane);
      moveToLane(second, safeLane);
      first.advanceGame(DELTA_LIMIT);
      second.advanceGame(DELTA_LIMIT);
    }

    assert.unreachable(`runs did not reach score ${targetScore}`);
  }

  function causeInitialCollision(game) {
    const initial = obstacleAt(game);
    moveToLane(game, initial.obstacle.blockedLane);

    for (let step = 0; step < 20_000; step += 1) {
      const before = obstacleAt(game);
      game.advanceGame(DELTA_LIMIT);
      const after = stateOf(game);
      if (after.status === "GAME_OVER") {
        assert.is(after.score, 0, "collision must happen before scoring");
        assert.is(after.finalScore, 0);
        return after;
      }
      assert.ok(after.obstacles[0].z > before.obstacle.z);
    }

    assert.unreachable("same-lane initial obstacle did not cause game over");
  }

  test("runs directly in Node without browser, canvas, or WebGL globals", () => {
    assert.is(typeof globalThis.window, "undefined");
    assert.is(typeof globalThis.document, "undefined");
    assert.is(typeof globalThis.HTMLCanvasElement, "undefined");
    assert.is(typeof globalThis.WebGLRenderingContext, "undefined");
  });

  test("creates an active centered deterministic run", () => {
    const first = createSeededGame(0x12345678);
    const second = createSeededGame(0x12345678);
    const firstState = stateOf(first);

    assert.is(firstState.status, "ACTIVE");
    assert.is(firstState.playerLane, "CENTER");
    assert.is(firstState.score, 0);
    assert.is(firstState.speed, 12);
    assert.is(firstState.seed, 0x12345678);
    assert.is(firstState.finalScore, null);
    assert.ok(firstState.obstacles.length > 0);
    assert.equal(firstState, stateOf(second));

    for (const obstacle of firstState.obstacles) {
      assert.ok(Number.isInteger(obstacle.id));
      assert.ok(LANES.includes(obstacle.blockedLane));
      assert.ok(Number.isFinite(obstacle.z));
      assert.is(obstacle.scored, false);
    }
  });

  test("accepts uint32 seed boundaries and rejects values outside them", () => {
    for (const seed of [0, UINT32_MAX]) {
      assert.is(stateOf(createSeededGame(seed)).seed, seed);
      assert.ok(createRandomState(seed));
    }

    for (const invalidSeed of [
      -1,
      UINT32_MAX + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "123",
    ]) {
      assert.throws(
        () => createGame({ seed: invalidSeed, seedMode: "EXPLICIT" }),
        RangeError,
      );
      assert.throws(() => createRandomState(invalidSeed), RangeError);
    }
  });

  test("moves exactly one bounded lane with Left and Right commands", () => {
    const game = createSeededGame(11);

    game.applyCommand("MOVE_LEFT");
    assert.is(stateOf(game).playerLane, "LEFT");
    game.applyCommand("MOVE_LEFT");
    assert.is(stateOf(game).playerLane, "LEFT");

    game.applyCommand("MOVE_RIGHT");
    assert.is(stateOf(game).playerLane, "CENTER");
    game.applyCommand("MOVE_RIGHT");
    assert.is(stateOf(game).playerLane, "RIGHT");
    game.applyCommand("MOVE_RIGHT");
    assert.is(stateOf(game).playerLane, "RIGHT");
  });

  test("implements a repeatable uint32 pseudorandom sequence", () => {
    const first = createRandomState(UINT32_MAX);
    const second = createRandomState(UINT32_MAX);
    const firstSequence = [];
    const secondSequence = [];

    for (let index = 0; index < 32; index += 1) {
      firstSequence.push(nextRandomUint32(first));
      secondSequence.push(nextRandomUint32(second));
    }

    assert.equal(firstSequence, secondSequence);
    assert.ok(new Set(firstSequence).size > 1, "the PRNG must advance its state");
    for (const value of firstSequence) {
      assert.ok(Number.isInteger(value));
      assert.ok(value >= 0 && value <= UINT32_MAX);
    }
  });

  test("keeps equal-seed obstacle sequences equal across multiple gates", () => {
    const first = createSeededGame(0x89abcdef);
    const second = createSeededGame(0x89abcdef);
    const completed = advanceEqualRunsSafely(first, second, 4);

    assert.ok(completed.score >= 4, "the comparison must cover generated gates");
    assert.is(completed.status, "ACTIVE");
  });

  test("normalizes deltas and advances obstacles by speed times delta", () => {
    assert.is(normalizeDelta(0.025), 0.025);
    assert.is(normalizeDelta(DELTA_LIMIT), DELTA_LIMIT);
    assert.is(normalizeDelta(0.5), DELTA_LIMIT);

    const game = createSeededGame(22);
    const before = stateOf(game);
    game.advanceGame(0.025);
    const after = stateOf(game);

    assert.is(after.obstacles.length, before.obstacles.length);
    before.obstacles.forEach((obstacle, index) => {
      assert.ok(
        Math.abs(after.obstacles[index].z - (obstacle.z + 12 * 0.025)) < 1e-10,
        "each obstacle must progress toward increasing z at the current speed",
      );
    });

    const clamped = createSeededGame(23);
    const limited = createSeededGame(23);
    clamped.advanceGame(10);
    limited.advanceGame(DELTA_LIMIT);
    assert.equal(stateOf(clamped), stateOf(limited));
  });

  test("treats invalid, nonnumeric, and nonpositive deltas as zero", () => {
    const invalidDeltas = [
      0,
      -0.01,
      "0.01",
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      {},
    ];

    for (const delta of invalidDeltas) {
      assert.is(normalizeDelta(delta), 0);
      const game = createSeededGame(24);
      const before = stateOf(game);
      game.advanceGame(delta);
      assert.equal(stateOf(game), before);
    }
  });

  test("derives speed from approved score bands and caps it at twenty", () => {
    const cases = [
      [0, 12],
      [4, 12],
      [5, 14],
      [9, 14],
      [10, 16],
      [14, 16],
      [15, 18],
      [19, 18],
      [20, 20],
      [25, 20],
      [1_000_000, 20],
    ];

    for (const [score, expectedSpeed] of cases) {
      assert.is(speedForScore(score), expectedSpeed, `score ${score}`);
    }
  });

  test("detects inclusive and swept collision segments", () => {
    assert.ok(segmentIntersectsCollisionZone(5.4, COLLISION_START));
    assert.ok(segmentIntersectsCollisionZone(COLLISION_START, COLLISION_START));
    assert.ok(segmentIntersectsCollisionZone(COLLISION_END, COLLISION_END));
    assert.ok(segmentIntersectsCollisionZone(COLLISION_END, 6.6));
    assert.ok(segmentIntersectsCollisionZone(5.49, 6.51));

    assert.not.ok(segmentIntersectsCollisionZone(5.0, 5.499999));
    assert.not.ok(segmentIntersectsCollisionZone(6.500001, 7.0));
  });

  test("scores a safe gate once and only after z is greater than 6.5", () => {
    const game = createSeededGame(31);
    const atBoundary = advanceObstacleTo(game, COLLISION_END, "safe");

    assert.ok(Math.abs(atBoundary.obstacle.z - COLLISION_END) < 1e-10);
    assert.is(atBoundary.state.status, "ACTIVE");
    assert.is(atBoundary.state.score, 0, "z=6.5 is not past the gate");

    game.advanceGame(0.000001);
    const scored = stateOf(game);
    assert.is(scored.status, "ACTIVE");
    assert.is(scored.score, 1);
    assert.is(scored.speed, speedForScore(1));
    assert.is(scored.obstacles[0].scored, true);

    for (let index = 0; index < 5; index += 1) {
      game.advanceGame(0.000001);
      assert.is(stateOf(game).score, 1, "one gate must not score twice");
    }
  });

  test("collides at both inclusive boundaries before scoring", () => {
    const entering = createSeededGame(41);
    const lowerBoundary = advanceObstacleTo(entering, COLLISION_START, "same");
    assert.ok(Math.abs(lowerBoundary.obstacle.z - COLLISION_START) < 1e-10);
    assert.is(lowerBoundary.state.status, "GAME_OVER");
    assert.is(lowerBoundary.state.score, 0);
    assert.is(lowerBoundary.state.finalScore, 0);

    const leaving = createSeededGame(42);
    const initial = obstacleAt(leaving);
    moveToLane(leaving, safeLaneFor(initial.obstacle.blockedLane));
    const nearUpper = advanceObstacleTo(leaving, COLLISION_END - 0.01, "safe");
    assert.is(nearUpper.state.status, "ACTIVE");
    moveToLane(leaving, nearUpper.obstacle.blockedLane);
    const remaining = COLLISION_END - nearUpper.obstacle.z;
    leaving.advanceGame(remaining / nearUpper.state.speed);
    const upperBoundary = obstacleAt(leaving);

    assert.ok(Math.abs(upperBoundary.obstacle.z - COLLISION_END) < 1e-10);
    assert.is(upperBoundary.state.status, "GAME_OVER");
    assert.is(upperBoundary.state.score, 0);
    assert.is(upperBoundary.state.finalScore, 0);
  });

  test("collides when a same-lane update sweeps into the collision interval", () => {
    const game = createSeededGame(43);
    const beforeSweep = advanceObstacleTo(game, 5.49, "same");
    assert.is(beforeSweep.state.status, "ACTIVE");

    game.advanceGame(DELTA_LIMIT);
    const collided = stateOf(game);
    assert.is(collided.status, "GAME_OVER");
    assert.is(collided.score, 0);
    assert.is(collided.finalScore, 0);
  });

  test("freezes commands and progression after game over", () => {
    const game = createSeededGame(44);
    const collided = causeInitialCollision(game);

    game.applyCommand("MOVE_LEFT");
    game.applyCommand("MOVE_RIGHT");
    game.advanceGame(DELTA_LIMIT);
    game.advanceGame(1);
    assert.equal(stateOf(game), collided);
  });

  test("explicit restart reproduces its seed and resets the complete run", () => {
    const seed = 0x10203040;
    const game = createSeededGame(seed);
    const initial = stateOf(game);

    assert.equal(game.restartGame(), initial, "an active run cannot restart");
    causeInitialCollision(game);
    game.restartGame();
    const restarted = stateOf(game);

    assert.equal(restarted, initial);
    assert.is(restarted.status, "ACTIVE");
    assert.is(restarted.playerLane, "CENTER");
    assert.is(restarted.score, 0);
    assert.is(restarted.speed, 12);
    assert.is(restarted.finalScore, null);
    assert.equal(restarted.obstacles, stateOf(createSeededGame(seed)).obstacles);

    causeInitialCollision(game);
    game.applyCommand("SELECT");
    assert.equal(stateOf(game), initial, "SELECT must use the explicit initial seed");
  });

  test("generated restarts require and use each fresh injected uint32 seed", () => {
    const game = createSeededGame(0x11223344, "GENERATED");
    causeInitialCollision(game);
    const collided = stateOf(game);

    assert.throws(() => game.restartGame(), RangeError);
    assert.equal(stateOf(game), collided, "failed restart must not alter state");

    const firstFreshSeed = 0x55667788;
    game.applyCommand("SELECT", firstFreshSeed);
    assert.equal(
      stateOf(game),
      stateOf(createSeededGame(firstFreshSeed, "GENERATED")),
      "generated SELECT restart must use the injected seed",
    );

    causeInitialCollision(game);
    const secondFreshSeed = 0xaabbccdd;
    game.restartGame(secondFreshSeed);
    assert.equal(
      stateOf(game),
      stateOf(createSeededGame(secondFreshSeed, "GENERATED")),
      "each generated restart must use its newly injected seed",
    );
  });

  test("snapshot and nested obstacle mutation cannot reach authoritative state", () => {
    const game = createSeededGame(51);
    const authoritative = stateOf(game);
    const exposed = stateOf(game);

    const attempt = (mutation) => {
      try {
        mutation();
      } catch (error) {
        assert.instance(error, TypeError);
      }
    };

    attempt(() => {
      exposed.playerLane = "RIGHT";
    });
    attempt(() => {
      exposed.score = 999;
    });
    attempt(() => {
      exposed.obstacles[0].blockedLane = "RIGHT";
    });
    attempt(() => {
      exposed.obstacles[0].z = 999;
    });
    attempt(() => {
      exposed.obstacles.push({
        id: 999,
        blockedLane: "CENTER",
        z: 0,
        scored: false,
      });
    });

    const afterMutation = stateOf(game);
    assert.equal(afterMutation, authoritative);
    assert.is.not(afterMutation, exposed);
    assert.is.not(afterMutation.obstacles, exposed.obstacles);
    assert.is.not(afterMutation.obstacles[0], exposed.obstacles[0]);
  });
}

test.run();
