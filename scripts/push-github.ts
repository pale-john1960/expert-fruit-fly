/**
 * push-github.ts — push the project to GitHub using the uploaded SSH key.
 *
 * The sandbox has no `ssh` binary, so we push through the pure-JS ssh2
 * wrapper (scripts/ssh-wrapper.ts). Run this any time — it is a no-op until
 * the private key appears at /home/z/my-project/upload/zai (or ~/.ssh/zai).
 *
 *   bun run scripts/push-github.ts
 */
import { execSync } from "child_process";
import { existsSync, copyFileSync, mkdirSync, chmodSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const REPO = "git@github.com:pale-john1960/expert-fruit-fly.git";
const UPLOAD_KEY = "/home/z/my-project/upload/zai";
const SSH_KEY = join(homedir(), ".ssh", "zai");

function log(msg: string) {
  const line = `[push-github] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    appendFileSync("/home/z/my-project/push-github.log", line + "\n");
  } catch {}
}

// 1. locate key
let key = null as string | null;
if (existsSync(SSH_KEY)) key = SSH_KEY;
else if (existsSync(UPLOAD_KEY)) {
  mkdirSync(join(homedir(), ".ssh"), { recursive: true });
  copyFileSync(UPLOAD_KEY, SSH_KEY);
  chmodSync(SSH_KEY, 0o600);
  key = SSH_KEY;
  log("installed uploaded key into ~/.ssh/zai");
}
if (!key) {
  log("no SSH key yet (waiting for /home/z/my-project/upload/zai) — nothing to do");
  process.exit(0);
}

// 2. make sure remote exists
try {
  execSync("git remote get-url origin", { cwd: "/home/z/my-project", stdio: "pipe" });
} catch {
  execSync(`git remote add origin ${REPO}`, { cwd: "/home/z/my-project" });
}

// 3. push via the ssh2 wrapper
const env = {
  ...process.env,
  GIT_SSH_COMMAND: "bun run /home/z/my-project/scripts/ssh-wrapper.ts",
  GIT_SSH_VARIANT: "ssh",
};
try {
  log("pushing HEAD to origin/main…");
  const out = execSync("git push -u origin HEAD:main 2>&1", {
    cwd: "/home/z/my-project",
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  log("push output:\n" + out);
  log("PUSH SUCCEEDED");
} catch (e: any) {
  log("push failed: " + (e.stdout || "") + (e.stderr || "") + e.message);
  process.exit(1);
}
