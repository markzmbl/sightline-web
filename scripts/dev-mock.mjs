// Runs the mock backend and Vite together (npm run dev:mock), with prefixed output.
// Ctrl+C, or either one exiting, stops both. No shell, so it behaves the same on Windows.
// MOCK_SPEED, MOCK_MIN_STAGE_MS and MOCK_RESTART_EVERY (a worker restart every nth run)
// pass through to the mock.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;

function start(name, args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const [input, output] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    createInterface({ input }).on("line", (line) => output.write(`[${name}] ${line}\n`));
  }
  child.on("exit", (code, signal) => {
    if (!stopping) console.log(`[${name}] exited (${signal ?? code}); stopping the other one`);
    stop(code ?? 0);
  });
  children.push(child);
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// PORT is Vite's (vite.config.ts); the mock stays on 8000, where Vite proxies /api.
start("mock", ["mock/server.ts"], { ...process.env, PORT: "8000" });
start("vite", ["node_modules/vite/bin/vite.js"]);
