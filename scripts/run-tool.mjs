// Vite cannot resolve a project whose Windows path contains '#'. Use a temporary
// drive alias; preserve symlinks so Vite/Rollup never expand it back to that path.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const bins = {
  vite: "vite/bin/vite.js",
  vitest: "vitest/vitest.mjs",
  tsx: "tsx/dist/cli.mjs",
};
const [tool, ...args] = process.argv.slice(2);
if (!bins[tool]) throw new Error("Unknown local tool");
let cwd = process.cwd();
let drive;
if (process.platform === "win32" && cwd.includes("#")) {
  for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
    if (existsSync(`${letter}:\\`)) continue;
    const mapped = spawnSync("subst.exe", [`${letter}:`, cwd]);
    if (mapped.status === 0) {
      drive = `${letter}:`;
      cwd = `${drive}\\`;
      break;
    }
  }
  if (!drive) throw new Error("No free drive for Vite; use a path without '#'");
}
const child = spawn(
  process.execPath,
  [
    "--preserve-symlinks",
    "--preserve-symlinks-main",
    resolve(cwd, "node_modules", bins[tool]),
    ...args,
  ],
  {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --preserve-symlinks --preserve-symlinks-main`,
    },
  },
);
function cleanup() {
  if (drive) spawnSync("subst.exe", [drive, "/D"]);
}
child.on("error", (error) => {
  cleanup();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  cleanup();
  process.exitCode = code ?? 1;
});
