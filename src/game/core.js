import {
  createRandomState,
  isUint32,
  nextRandomUint32,
} from "./random.js";

const LANES = Object.freeze(["LEFT", "CENTER", "RIGHT"]);
const ACTIVE = "ACTIVE";
const GAME_OVER = "GAME_OVER";
const EXPLICIT = "EXPLICIT";
const GENERATED = "GENERATED";

const BASE_SPEED = 12;
const MAX_SPEED = 20;
const SPEED_SCORE_BAND = 5;
const SPEED_INCREMENT = 2;
const MAX_DELTA = 0.05;

const COLLISION_START = 5.5;
const COLLISION_END = 6.5;
const SPAWN_Z = 0;
const SPAWN_DISTANCE = 8;
const DESPAWN_Z = 12;

export function normalizeDelta(delta) {
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta <= 0) {
    return 0;
  }

  return Math.min(delta, MAX_DELTA);
}

export function speedForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) {
    return BASE_SPEED;
  }

  const band = Math.floor(score / SPEED_SCORE_BAND);
  return Math.min(BASE_SPEED + band * SPEED_INCREMENT, MAX_SPEED);
}

export function segmentIntersectsCollisionZone(startZ, endZ) {
  if (!Number.isFinite(startZ) || !Number.isFinite(endZ)) {
    return false;
  }

  const segmentStart = Math.min(startZ, endZ);
  const segmentEnd = Math.max(startZ, endZ);
  return segmentEnd >= COLLISION_START && segmentStart <= COLLISION_END;
}

export function spawnObstacle(randomState, id, z = SPAWN_Z) {
  return {
    id,
    blockedLane: LANES[nextRandomUint32(randomState) % LANES.length],
    z,
    scored: false,
  };
}

function createInitialState(seed) {
  const randomState = createRandomState(seed);

  return {
    state: {
      status: ACTIVE,
      playerLane: "CENTER",
      score: 0,
      speed: BASE_SPEED,
      seed,
      finalScore: null,
      obstacles: [spawnObstacle(randomState, 0)],
    },
    randomState,
    nextObstacleId: 1,
  };
}

function snapshotOf(state) {
  const obstacles = state.obstacles.map((obstacle) =>
    Object.freeze({ ...obstacle }),
  );

  return Object.freeze({
    status: state.status,
    playerLane: state.playerLane,
    score: state.score,
    speed: state.speed,
    seed: state.seed,
    finalScore: state.finalScore,
    obstacles: Object.freeze(obstacles),
  });
}

function laneAfterMove(currentLane, offset) {
  const currentIndex = LANES.indexOf(currentLane);
  const nextIndex = Math.max(
    0,
    Math.min(currentIndex + offset, LANES.length - 1),
  );
  return LANES[nextIndex];
}

function assertSeed(seed) {
  if (!isUint32(seed)) {
    throw new RangeError("seed must be a uint32");
  }
}

function assertSeedMode(seedMode) {
  if (seedMode !== EXPLICIT && seedMode !== GENERATED) {
    throw new RangeError('seedMode must be "EXPLICIT" or "GENERATED"');
  }
}

export function createGame({ seed, seedMode = EXPLICIT } = {}) {
  assertSeed(seed);
  assertSeedMode(seedMode);

  const explicitSeed = seed;
  let run = createInitialState(seed);

  function getSnapshot() {
    return snapshotOf(run.state);
  }

  function restartGame(freshSeed) {
    if (run.state.status !== GAME_OVER) {
      return getSnapshot();
    }

    let restartSeed = explicitSeed;
    if (seedMode === GENERATED) {
      assertSeed(freshSeed);
      restartSeed = freshSeed;
    }

    run = createInitialState(restartSeed);
    return getSnapshot();
  }

  function applyCommand(command, freshSeed) {
    if (run.state.status === GAME_OVER) {
      if (command === "SELECT") {
        return restartGame(freshSeed);
      }
      return getSnapshot();
    }

    if (command === "MOVE_LEFT") {
      run.state.playerLane = laneAfterMove(run.state.playerLane, -1);
    } else if (command === "MOVE_RIGHT") {
      run.state.playerLane = laneAfterMove(run.state.playerLane, 1);
    }

    return getSnapshot();
  }

  function advanceGame(delta) {
    const normalizedDelta = normalizeDelta(delta);
    if (run.state.status === GAME_OVER || normalizedDelta === 0) {
      return getSnapshot();
    }

    const distance = run.state.speed * normalizedDelta;
    const movements = run.state.obstacles.map((obstacle) => ({
      obstacle,
      previousZ: obstacle.z,
      nextZ: obstacle.z + distance,
    }));

    for (const movement of movements) {
      movement.obstacle.z = movement.nextZ;
    }

    const collided = movements.some(
      ({ obstacle, previousZ, nextZ }) =>
        obstacle.blockedLane === run.state.playerLane &&
        segmentIntersectsCollisionZone(previousZ, nextZ),
    );

    if (collided) {
      run.state.status = GAME_OVER;
      run.state.finalScore = run.state.score;
      return getSnapshot();
    }

    for (const obstacle of run.state.obstacles) {
      if (!obstacle.scored && obstacle.z > COLLISION_END) {
        obstacle.scored = true;
        run.state.score += 1;
      }
    }
    run.state.speed = speedForScore(run.state.score);

    const newestObstacle = run.state.obstacles.at(-1);
    if (newestObstacle.z >= SPAWN_DISTANCE) {
      run.state.obstacles.push(
        spawnObstacle(
          run.randomState,
          run.nextObstacleId,
          newestObstacle.z - SPAWN_DISTANCE,
        ),
      );
      run.nextObstacleId += 1;
    }

    run.state.obstacles = run.state.obstacles.filter(
      (obstacle) => obstacle.z <= DESPAWN_Z,
    );

    return getSnapshot();
  }

  return Object.freeze({
    applyCommand,
    advanceGame,
    restartGame,
    getSnapshot,
  });
}
