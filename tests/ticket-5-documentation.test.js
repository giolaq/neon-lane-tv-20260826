import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { suite } from "uvu";
import * as assert from "uvu/assert";

const ROOT = resolve(import.meta.dirname, "..");
const README_PATH = resolve(ROOT, "README.md");
const PACKAGE_PATH = resolve(ROOT, "package.json");
const UINT32_MAX = 0xffffffff;
const readmeExists = existsSync(README_PATH);
const readme = readmeExists ? readFileSync(README_PATH, "utf8") : "";
const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
const test = suite("ticket #5 documentation acceptance");

function fencedCommands(markdown) {
  const commands = [];
  const fencePattern = /```[^\n]*\n([\s\S]*?)```/g;

  for (const match of markdown.matchAll(fencePattern)) {
    for (const line of match[1].split(/\r?\n/)) {
      const command = line.trim().replace(/^\$\s+/, "");
      if (command !== "") {
        commands.push(command);
      }
    }
  }

  return commands;
}

function lineContainsAll(markdown, terms) {
  return markdown
    .split(/\r?\n/)
    .some((line) => terms.every((term) => line.includes(term)));
}

test("provides a root README for the operator workflow", () => {
  assert.ok(readmeExists, "README.md must exist at the repository root");
  assert.match(
    readme,
    /repository root/i,
    "README must state where the documented commands are run",
  );
});

test("documents executable install, launch, test, and build commands", () => {
  const commands = fencedCommands(readme);

  assert.ok(
    commands.includes("npm ci") || commands.includes("npm install"),
    "README must provide an npm installation command in a code fence",
  );
  for (const command of ["npm start", "npm test", "npm run build"]) {
    assert.ok(
      commands.includes(command),
      `README must provide \`${command}\` as an executable command`,
    );
  }

  for (const script of ["start", "test", "build"]) {
    assert.type(
      packageJson.scripts?.[script],
      "string",
      `the documented npm ${script} workflow must be backed by package.json`,
    );
  }
});

test("pairs every named control with its supported numeric equivalent", () => {
  const controls = [
    ["ArrowLeft", "37"],
    ["ArrowRight", "39"],
    ["Enter", "13"],
    ["Space", "32"],
  ];

  assert.match(
    readme,
    /remote/i,
    "README must identify the numeric codes as remote-equivalent controls",
  );
  for (const terms of controls) {
    assert.ok(
      lineContainsAll(readme, terms),
      `README must pair ${terms[0]} with numeric code ${terms[1]}`,
    );
  }
});

test("documents explicit decimal uint32 seed usage and both boundaries", () => {
  assert.ok(
    readme.includes("?seed=<uint32>"),
    "README must show the explicit ?seed=<uint32> query form",
  );
  assert.match(
    readme,
    /\b0\b[\s\S]*\b4294967295\b|\b4294967295\b[\s\S]*\b0\b/,
    "README must state the inclusive uint32 range 0 through 4294967295",
  );

  const examples = [...readme.matchAll(/\?seed=(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  assert.ok(
    examples.some(
      (seed) => Number.isInteger(seed) && seed >= 0 && seed <= UINT32_MAX,
    ),
    "README must include a concrete valid decimal seed URL example",
  );
});

test.run();
