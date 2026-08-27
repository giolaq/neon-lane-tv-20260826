const ACTIVE = "ACTIVE";

function requireElement(value, label) {
  if (!value || typeof value.append !== "function") {
    throw new TypeError(`${label} must be an element`);
  }
}

export function createHud(container = document.body) {
  requireElement(container, "container");

  const root = document.createElement("div");
  root.className = "hud";

  const score = document.createElement("output");
  score.className = "hud-score";
  score.setAttribute("aria-live", "polite");
  score.setAttribute("aria-label", "Current score");

  const gameOver = document.createElement("section");
  gameOver.className = "hud-game-over";
  gameOver.setAttribute("role", "status");
  gameOver.setAttribute("aria-live", "assertive");
  gameOver.hidden = true;

  const gameOverLabel = document.createElement("h1");
  gameOverLabel.className = "hud-game-over-label";
  gameOverLabel.textContent = "Game Over";

  const finalScore = document.createElement("output");
  finalScore.className = "hud-final-score";
  finalScore.setAttribute("aria-label", "Final score");

  gameOver.append(gameOverLabel, finalScore);
  root.append(score, gameOver);
  container.append(root);

  return Object.freeze({
    root,
    score,
    gameOver,
    finalScore,
  });
}

export function renderHud(hud, snapshot) {
  if (!hud || !snapshot) {
    throw new TypeError("hud and snapshot are required");
  }

  const isActive = snapshot.status === ACTIVE;
  hud.score.hidden = !isActive;
  hud.gameOver.hidden = isActive;

  if (isActive) {
    hud.score.textContent = `Score: ${snapshot.score}`;
  } else {
    const score = snapshot.finalScore ?? snapshot.score;
    hud.finalScore.textContent = `Final Score: ${score}`;
  }
}
