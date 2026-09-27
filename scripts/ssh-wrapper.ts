/**
 * SSH wrapper for git over a pure-JS SSH client (ssh2).
 *
 * Why: this sandbox has no `ssh` binary and no sudo to install one, so git
 * cannot use a normal GIT_SSH_COMMAND. Git invokes this script exactly like
 * it would invoke ssh:
 *
 *     ssh-wrapper.ts [options] git@github.com "git-receive-pack 'user/repo.git'"
 *
 * We parse the host + command, connect with the ssh2 module using the
 * uploaded deploy key, and pipe stdio — git never knows the difference.
 *
 * Usage:
 *   GIT_SSH_COMMAND="bun run scripts/ssh-wrapper.ts" git push origin main
 *
 * The private key is expected at $FLY_SSH_KEY, else ~/.ssh/zai,
 * else /home/z/my-project/upload/zai.
 */
import { Client } from "ssh2";
import { readFileSync, existsSync, copyFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// --- locate the private key -----------------------------------------------
function keyPath(): string | null {
  const candidates = [
    process.env.FLY_SSH_KEY,
    join(homedir(), ".ssh", "zai"),
    "/home/z/my-project/upload/zai",
  ].filter(Boolean) as string[];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// install the key into ~/.ssh with sane permissions (best effort)
function installKey(src: string) {
  try {
    const dir = join(homedir(), ".ssh");
    mkdirSync(dir, { recursive: true });
    const dst = join(dir, "zai");
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
    return dst;
  } catch {
    return src;
  }
}

// --- parse git's ssh invocation --------------------------------------------
const args = process.argv.slice(2);
let host = "";
let command = "";
let port = 22;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-p") {
    port = parseInt(args[i + 1], 10) || 22;
    i++;
  } else if (a.startsWith("-")) {
    // skip flags and their values for common cases (-o StrictHostKeyChecking=…)
    if (a === "-o" || a === "-i" || a === "-T") i++;
  } else if (a.includes("@") && a.includes(".")) {
    host = a;
  } else {
    command = a; // the last non-flag arg is the remote command
  }
}

if (!host || !command) {
  process.stderr.write(
    `ssh-wrapper: could not parse git ssh invocation: ${args.join(" ")}\n`
  );
  process.exit(64);
}

const [user, hostname] = host.includes("@") ? host.split("@") : ["git", host];

const kp = keyPath();
if (!kp) {
  process.stderr.write(
    "ssh-wrapper: no private key found (looked at $FLY_SSH_KEY, ~/.ssh/zai, upload/zai)\n"
  );
  process.exit(78);
}
const keyFile = installKey(kp);
let privateKey: string;
try {
  privateKey = readFileSync(keyFile, "utf8");
} catch (e) {
  process.stderr.write(`ssh-wrapper: cannot read key ${keyFile}: ${e}\n`);
  process.exit(66);
}

const conn = new Client();
conn
  .on("ready", () => {
    conn.exec(command, (err: Error | undefined, stream: any) => {
      if (err) {
        process.stderr.write(`ssh-wrapper: exec failed: ${err.message}\n`);
        conn.end();
        process.exit(1);
      }
      stream.on("data", (d: Buffer) => process.stdout.write(d));
      stream.stderr.on("data", (d: Buffer) => process.stderr.write(d));
      process.stdin.on("data", (d: Buffer) => stream.write(d));
      process.stdin.resume();
      stream.on("close", (code: number) => {
        conn.end();
        process.exit(code || 0);
      });
    });
  })
  .on("error", (err: Error) => {
    process.stderr.write(`ssh-wrapper: ssh error: ${err.message}\n`);
    process.exit(255);
  })
  .connect({
    host: hostname,
    port,
    user,
    privateKey,
    readyTimeout: 20000,
  });
