import contextlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = REPOSITORY_ROOT / "package.json"
PACKAGE_LOCK = REPOSITORY_ROOT / "package-lock.json"
VITE_CONFIG = REPOSITORY_ROOT / "vite.config.js"


class Ticket1ProjectLifecycleTests(unittest.TestCase):
    maxDiff = None

    def _read_json(self, path):
        self.assertTrue(
            path.is_file(),
            f"{path.name} must exist at the repository root",
        )
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            self.fail(f"{path.name} must contain valid JSON: {error}")

    def _package(self):
        package = self._read_json(PACKAGE_JSON)
        self.assertIsInstance(package, dict, "package.json must contain an object")
        return package

    def _script_tokens(self, package, name):
        scripts = package.get("scripts")
        self.assertIsInstance(scripts, dict, "package.json must define scripts")
        script = scripts.get(name)
        self.assertIsInstance(script, str, f"npm {name} must be configured")
        self.assertTrue(script.strip(), f"npm {name} must not be empty")
        try:
            return shlex.split(script)
        except ValueError as error:
            self.fail(f"npm {name} must be a valid command: {error}")

    @contextlib.contextmanager
    def _isolated_project(self):
        with tempfile.TemporaryDirectory(prefix="ticket-1-") as temporary:
            project = Path(temporary) / "project"
            project.mkdir()
            ignored = {".factory", ".git", "coverage", "dist", "node_modules"}

            for entry in REPOSITORY_ROOT.iterdir():
                if entry.name in ignored:
                    continue
                destination = project / entry.name
                if entry.is_dir():
                    shutil.copytree(entry, destination)
                else:
                    shutil.copy2(entry, destination)

            installed_dependencies = REPOSITORY_ROOT / "node_modules"
            if installed_dependencies.is_dir():
                (project / "node_modules").symlink_to(
                    installed_dependencies,
                    target_is_directory=True,
                )
            yield project

    def _npm_environment(self):
        environment = os.environ.copy()
        environment.update(
            {
                "CI": "true",
                "NO_COLOR": "1",
                "npm_config_audit": "false",
                "npm_config_fund": "false",
                "npm_config_offline": "true",
                "npm_config_update_notifier": "false",
            }
        )
        return environment

    def _run_npm(self, arguments, project, timeout=60):
        try:
            completed = subprocess.run(
                ["npm", *arguments],
                cwd=project,
                env=self._npm_environment(),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError:
            self.fail("npm must be available to execute repository-root commands")
        except subprocess.TimeoutExpired as error:
            output = (error.stdout or "")[-3000:]
            self.fail(
                f"npm {' '.join(arguments)} did not exit within {timeout}s\n{output}"
            )

        self.assertEqual(
            completed.returncode,
            0,
            f"npm {' '.join(arguments)} failed\n{completed.stdout[-3000:]}",
        )
        return completed

    def test_repository_root_defines_required_direct_scripts(self):
        package = self._package()
        start = self._script_tokens(package, "start")
        test = self._script_tokens(package, "test")
        build = self._script_tokens(package, "build")

        self.assertEqual(start[0], "vite", "npm start must launch Vite")
        self.assertEqual(build[:2], ["vite", "build"], "npm run build must build with Vite")
        self.assertNotEqual(
            test[0],
            "vite",
            "npm test must use the configured test runner, not the Vite server",
        )

    def test_runtime_and_tooling_dependencies_are_classified(self):
        package = self._package()
        dependencies = package.get("dependencies")
        development_dependencies = package.get("devDependencies")

        self.assertIsInstance(dependencies, dict)
        self.assertEqual(
            set(dependencies),
            {"three"},
            "Three.js must be the only runtime dependency",
        )
        self.assertIsInstance(development_dependencies, dict)
        self.assertIn("vite", development_dependencies, "Vite must be a dev dependency")

        test_runner = self._script_tokens(package, "test")[0]
        self.assertIn(
            test_runner,
            development_dependencies,
            "the configured test runner must be a dev dependency",
        )
        self.assertNotIn("three", development_dependencies)

    def test_lockfile_records_the_root_dependency_contract(self):
        package = self._package()
        lockfile = self._read_json(PACKAGE_LOCK)

        self.assertGreaterEqual(
            lockfile.get("lockfileVersion", 0),
            2,
            "package-lock.json must use the modern packages format",
        )
        locked_packages = lockfile.get("packages")
        self.assertIsInstance(locked_packages, dict)
        locked_root = locked_packages.get("")
        self.assertIsInstance(locked_root, dict)

        for dependency_kind in ("dependencies", "devDependencies"):
            self.assertEqual(
                locked_root.get(dependency_kind, {}),
                package.get(dependency_kind, {}),
                f"package-lock root {dependency_kind} must match package.json",
            )
            for dependency in package.get(dependency_kind, {}):
                self.assertIn(
                    f"node_modules/{dependency}",
                    locked_packages,
                    f"package-lock.json must resolve {dependency}",
                )

    def test_vite_configuration_is_present(self):
        self._package()
        self.assertTrue(
            VITE_CONFIG.is_file(),
            "vite.config.js must exist at the repository root",
        )
        self.assertGreater(
            VITE_CONFIG.stat().st_size,
            0,
            "vite.config.js must not be empty",
        )

    def test_npm_test_exits_successfully_offline(self):
        self._package()
        with self._isolated_project() as project:
            self._run_npm(["test"], project)

    def test_npm_build_produces_a_browser_bundle_offline(self):
        self._package()
        with self._isolated_project() as project:
            self._run_npm(["run", "build"], project)
            distribution = project / "dist"
            self.assertTrue(distribution.is_dir(), "Vite must create dist/")
            self.assertTrue(
                (distribution / "index.html").is_file(),
                "the production bundle must include dist/index.html",
            )
            self.assertTrue(
                any(path.suffix == ".js" for path in distribution.rglob("*.js")),
                "the production bundle must include JavaScript",
            )

    def test_npm_start_serves_html_on_an_explicit_port(self):
        self._package()
        with self._isolated_project() as project:
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]

            command = [
                "npm",
                "start",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--strictPort",
            ]
            try:
                process = subprocess.Popen(
                    command,
                    cwd=project,
                    env=self._npm_environment(),
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except FileNotFoundError:
                self.fail("npm must be available to launch the development server")

            response = None
            last_error = None
            output = ""
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        break
                    try:
                        response = opener.open(
                            f"http://127.0.0.1:{port}/",
                            timeout=1,
                        )
                        break
                    except (OSError, urllib.error.URLError) as error:
                        last_error = error
                        time.sleep(0.1)

                self.assertIsNotNone(
                    response,
                    f"npm start did not expose HTTP on port {port}: {last_error}",
                )
                self.assertIsNone(
                    process.poll(),
                    "the development server exited before the smoke request",
                )
                body = response.read().decode("utf-8", errors="replace")
                self.assertEqual(response.status, 200)
                self.assertIn("text/html", response.headers.get("Content-Type", ""))
                self.assertRegex(body.lower(), r"<!doctype html|<html")
            finally:
                if response is not None:
                    response.close()
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    output = process.communicate(timeout=5)[0] or ""
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    output = process.communicate(timeout=5)[0] or ""

            self.assertNotIn(
                "error when starting dev server",
                output.lower(),
                f"Vite reported a startup error\n{output[-3000:]}",
            )


if __name__ == "__main__":
    unittest.main()
