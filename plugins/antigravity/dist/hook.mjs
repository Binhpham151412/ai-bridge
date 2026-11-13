// src/chat-hosts/review-deps.ts
import { homedir } from "node:os";
import path3 from "node:path";

// src/adapters/chatgpt/codex-cli-adapter.ts
import { readFile } from "node:fs/promises";

// src/automation/process-runner.ts
import { spawn } from "node:child_process";
var DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
function runProcess(options) {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.pid !== void 0) options.onSpawn?.(child.pid);
    let timedOut = false;
    let settled = false;
    const inputBytes = options.input === void 0 ? 0 : Buffer.byteLength(options.input, "utf8");
    let inputDelivered = false;
    let inputError = null;
    child.stdin.on("error", (err) => {
      inputError = err.message;
    });
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, options.timeoutMs);
    child.stdout.on("data", (c) => {
      if (stdoutBytes >= maxBufferBytes) {
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(c);
      stdoutBytes += c.length;
    });
    child.stderr.on("data", (c) => {
      if (stderrBytes >= maxBufferBytes) {
        stderrTruncated = true;
        return;
      }
      stderrChunks.push(c);
      stderrBytes += c.length;
    });
    child.on("error", () => {
      finish(null, null);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
    function finish(exitCode, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        pid: child.pid ?? null,
        startedAt: startedAtIso,
        endedAt: (/* @__PURE__ */ new Date()).toISOString(),
        inputBytes,
        inputDelivered,
        inputError
      });
    }
    if (options.input !== void 0) {
      child.stdin.end(options.input, "utf8", (err) => {
        if (err) {
          inputError = inputError ?? err.message;
          return;
        }
        if (inputError !== null) return;
        inputDelivered = true;
        options.onInputFlushed?.(inputBytes);
      });
    } else {
      child.stdin.end();
    }
  });
}
function killProcessTree(pid) {
  if (pid === void 0) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
}

// src/adapters/chatgpt/codex-cli-adapter.ts
function codexPermissionArgs(policy, resume) {
  if (policy === "bypass") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (policy === "ask") return resume ? ["-c", 'sandbox_mode="read-only"'] : ["-s", "read-only"];
  throw new Error(`Unsupported Codex permission policy: ${JSON.stringify(policy)}`);
}
function findReportedCodexThreadId(stdout) {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "thread.started" && typeof e.thread_id === "string") return e.thread_id;
    } catch {
    }
  }
  return null;
}
var CodexCliAdapter = class {
  executable;
  commandArgsPrefix;
  constructor(options) {
    this.executable = options.executable;
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
  }
  async run(options) {
    const policy = options.permissionPolicy ?? "ask";
    const args = options.threadId === null ? [...this.commandArgsPrefix, "exec", "--json", ...codexPermissionArgs(policy, false), "--skip-git-repo-check", "-o", options.outputPath, "-"] : [
      ...this.commandArgsPrefix,
      "exec",
      "resume",
      options.threadId,
      "--json",
      ...codexPermissionArgs(policy, true),
      "--skip-git-repo-check",
      "-o",
      options.outputPath,
      "-"
    ];
    const proc = await runProcess({
      command: this.executable,
      args,
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      timeoutMs: options.timeoutMs,
      onSpawn: options.onSpawn,
      onInputFlushed: options.onInputFlushed
    });
    const base = {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      stderr: proc.stderr,
      durationMs: proc.durationMs,
      stdout: proc.stdout,
      stdoutTruncated: proc.stdoutTruncated,
      stderrTruncated: proc.stderrTruncated,
      reportedThreadId: findReportedCodexThreadId(proc.stdout),
      pid: proc.pid,
      signal: proc.signal,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      inputBytes: proc.inputBytes,
      inputDelivered: proc.inputDelivered,
      inputDeliveryError: proc.inputError,
      executable: this.executable,
      args
    };
    const fail = (errorCode, threadId = null) => ({ ok: false, threadId, errorCode, responseText: null, ...base });
    if (proc.timedOut) return fail("TIMEOUT");
    if (proc.exitCode === null && proc.signal === null) return fail("SPAWN_FAILED");
    if (proc.exitCode !== 0) return fail("NON_ZERO_EXIT");
    const lines = proc.stdout.split("\n").filter((l) => l.trim() !== "");
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        return fail("BAD_JSON");
      }
    }
    if (!events.some((e) => e.type === "turn.completed")) return fail("NO_TURN_COMPLETED");
    const threadStarted = events.find((e) => e.type === "thread.started");
    const reportedThreadId = typeof threadStarted?.thread_id === "string" ? threadStarted.thread_id : null;
    const expectedThreadId = options.threadId;
    if (reportedThreadId === null || expectedThreadId !== null && reportedThreadId !== expectedThreadId) {
      return fail("THREAD_MISMATCH", reportedThreadId);
    }
    let responseText;
    try {
      responseText = await readFile(options.outputPath, "utf8");
    } catch {
      return fail("OUTPUT_FILE_MISSING", reportedThreadId);
    }
    return { ok: true, threadId: reportedThreadId, errorCode: null, responseText, ...base };
  }
};

// src/claude-code/codex-account.ts
import { readdir, readFile as readFile2 } from "node:fs/promises";
import path from "node:path";
function checkCodeMode(env) {
  const v = (env.AI_BRIDGE_CODEX_CHECK_CODE ?? "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : "auto";
}
function shouldCheckCode(mode, account) {
  if (mode !== "auto") return mode === "on";
  return account?.plan != null && account.plan !== "free";
}
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
function rateLimitsOf(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4) return null;
  const rl = value.rate_limits;
  if (rl !== null && typeof rl === "object") return rl;
  for (const child of Object.values(value)) {
    const found = rateLimitsOf(child, depth + 1);
    if (found) return found;
  }
  return null;
}
function accountFromRollout(text) {
  let last = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      last = rateLimitsOf(JSON.parse(line)) ?? last;
    } catch {
    }
  }
  if (last === null) return null;
  const windows = [last.primary, last.secondary].filter((w2) => w2 !== null && typeof w2 === "object" && num(w2.used_percent) !== null).sort((a, b) => (num(b.used_percent) ?? 0) - (num(a.used_percent) ?? 0));
  const w = windows[0];
  return {
    plan: typeof last.plan_type === "string" ? last.plan_type : null,
    usedPercent: w ? num(w.used_percent) : null,
    windowMinutes: w ? num(w.window_minutes) : null,
    resetsAt: w ? num(w.resets_at) : null
  };
}
var DAYS_SEARCHED = 120;
async function names(dir) {
  return (await readdir(dir).catch(() => [])).sort().reverse();
}
async function findRollout(codexHome, threadId) {
  const sessions = path.join(codexHome, "sessions");
  let days = 0;
  for (const y of await names(sessions)) {
    for (const m of await names(path.join(sessions, y))) {
      for (const d of await names(path.join(sessions, y, m))) {
        if (++days > DAYS_SEARCHED) return null;
        const dir = path.join(sessions, y, m, d);
        const hit = (await names(dir)).find((f) => f.endsWith(`-${threadId}.jsonl`));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}
async function readCodexAccount(codexHome, threadId) {
  if (!/^[0-9A-Za-z-]{8,64}$/.test(threadId)) return null;
  const file = await findRollout(codexHome, threadId);
  if (file === null) return null;
  return accountFromRollout(await readFile2(file, "utf8").catch(() => ""));
}

// src/claude-code/git-changes.ts
import { execFile } from "node:child_process";
var DEFAULT_MAX_CHARS = 3e4;
var GIT_TIMEOUT_MS = 15e3;
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
}
async function headCommit(cwd) {
  const out = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return out?.trim() || null;
}
async function changesSince(cwd, base, maxChars = DEFAULT_MAX_CHARS) {
  const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status === null) return null;
  const diff = await git(cwd, ["diff", base ?? "HEAD"]) ?? "";
  if (status.trim() === "" && diff.trim() === "") return null;
  const text = [`$ git status --porcelain`, status.trimEnd() || "(clean)", "", `$ git diff ${base ?? "HEAD"}`, diff.trimEnd() || "(no changes)"].join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}
\u2026 (cut at ${maxChars} characters; read the files for the rest)`;
}

// src/claude-code/notify.ts
import { execFile as execFile2 } from "node:child_process";
var NOTIFY_TIMEOUT_MS = 1e4;
var xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
var ps = (s) => `'${s.replace(/'/g, "''")}'`;
var WINDOWS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
function notifyCommand(platform, title, body) {
  if (platform === "win32") {
    const toast = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
      "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `$doc.LoadXml(${ps(toast)})`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${ps(WINDOWS_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($doc))`
    ].join("\n");
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
  }
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body] };
  }
  if (platform === "linux") return { command: "notify-send", args: ["--app-name=AI Bridge", title, body] };
  return null;
}
function osNotify(title, body) {
  const c = notifyCommand(process.platform, title, body);
  if (c === null) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      execFile2(c.command, c.args, { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true }, () => resolve()).stdin?.end();
    } catch {
      resolve();
    }
  });
}

// src/core/executor/executor-adapter.ts
var DEFAULT_EXECUTOR_PROVIDER = "claude-code";

// src/core/permissions/permission-policy.ts
var DEFAULT_PERMISSION_POLICY = "bypass";
function defaultProviderPermissions() {
  return { claude: DEFAULT_PERMISSION_POLICY, codex: DEFAULT_PERMISSION_POLICY, opencode: DEFAULT_PERMISSION_POLICY, antigravity: DEFAULT_PERMISSION_POLICY };
}

// src/core/config/config.ts
var DEFAULT_CONFIG = {
  maxIterations: 10,
  claudeTimeoutMs: 18e5,
  codexTimeoutMs: 6e5,
  reportMaxBytes: 1048576,
  stopOnUncommittedChanges: false,
  requireGitRepository: false,
  permissions: defaultProviderPermissions(),
  models: { claude: null, opencode: null },
  executor: { provider: DEFAULT_EXECUTOR_PROVIDER }
};
var NUMBER_FIELDS = ["maxIterations", "claudeTimeoutMs", "codexTimeoutMs", "reportMaxBytes"];
var BOOLEAN_FIELDS = ["stopOnUncommittedChanges", "requireGitRepository"];
var KNOWN_FIELDS = [...NUMBER_FIELDS, ...BOOLEAN_FIELDS, "permissions", "models", "executor"];

// src/core/providers/executable-discovery.ts
import { execFile as execFile3 } from "node:child_process";
import { readdir as readdir2, stat } from "node:fs/promises";
import path2 from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile3);
function pickSpawnableExecutable(hits, platform) {
  if (hits.length === 0) return null;
  if (platform === "win32") return hits.find((h) => h.toLowerCase().endsWith(".exe")) ?? hits[0];
  return hits[0];
}
async function discoverExecutable(name, deps2) {
  const hits = await deps2.where(name).catch(() => []);
  const onPath = pickSpawnableExecutable(hits, deps2.platform);
  if (onPath !== null && !(deps2.platform === "win32" && !onPath.toLowerCase().endsWith(".exe") && deps2.nativeFromShim)) return onPath;
  if (deps2.platform === "win32" && deps2.nativeFromShim && hits.length > 0) {
    const native = await deps2.nativeFromShim(name, hits).catch(() => null);
    if (native !== null) return native;
    if (onPath !== null) return onPath;
  }
  if (!deps2.fallback) return null;
  return pickSpawnableExecutable(await deps2.fallback(name).catch(() => []), deps2.platform);
}
async function realWhere(name) {
  const [cmd, args] = process.platform === "win32" ? ["where", [name]] : ["which", ["-a", name]];
  const { stdout } = await execFileAsync(cmd, args, { timeout: 1e4, windowsHide: true });
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
async function realFallback(name, env) {
  if (name !== "codex" || !env.LOCALAPPDATA) return [];
  const base = path2.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const dirs = await readdir2(base).catch(() => []);
  const found = await Promise.all(
    dirs.map(async (d) => {
      const p = path2.join(base, d, "codex.exe");
      const s = await stat(p).catch(() => null);
      return s?.isFile() ? { p, t: s.mtimeMs } : null;
    })
  );
  return found.filter((x) => x !== null).sort((a, b) => b.t - a.t).map((x) => x.p);
}
async function findNativeExecutableNextToNpmShim(name, hits) {
  const exists = (p) => stat(p).then((s) => s.isFile(), () => false);
  const dirs = [...new Set(hits.map((h) => path2.dirname(h)))];
  for (const dir of dirs) {
    const modules = path2.join(dir, "node_modules");
    const candidates = [];
    for (const pkg of await readdir2(modules).catch(() => [])) {
      candidates.push(path2.join(modules, pkg, "bin", `${name}.exe`));
      const nested = path2.join(modules, pkg, "node_modules");
      for (const sub of await readdir2(nested).catch(() => [])) candidates.push(path2.join(nested, sub, "bin", `${name}.exe`));
    }
    candidates.sort((a, b) => Number(/baseline/i.test(a)) - Number(/baseline/i.test(b)));
    for (const c of candidates) if (await exists(c)) return c;
  }
  return null;
}
function createRealExecutableLocator(env = process.env) {
  return (name) => discoverExecutable(name, { where: realWhere, fallback: (n) => realFallback(n, env), nativeFromShim: findNativeExecutableNextToNpmShim, platform: process.platform });
}

// src/chat-hosts/review-deps.ts
var API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
function reviewerEnv(env) {
  const clean = { ...env };
  for (const key of API_KEY_VARS) delete clean[key];
  return clean;
}
var stateRootOf = (host, overrideVar, env = process.env) => env[overrideVar] || path3.join(homedir(), ".ai-bridge", host);
function realReviewDeps(env = process.env) {
  return {
    env: reviewerEnv(env),
    codexTimeoutMs: DEFAULT_CONFIG.codexTimeoutMs,
    headCommit,
    changesSince,
    codexAccount: (threadId) => readCodexAccount(env.CODEX_HOME || path3.join(homedir(), ".codex"), threadId),
    notify: osNotify,
    locateCodex: async () => {
      const exe = await createRealExecutableLocator()("codex");
      return exe === null ? null : new CodexCliAdapter({ executable: exe });
    }
  };
}

// src/chat-hosts/antigravity/hooks.ts
import { mkdir as mkdir3, readFile as readFile6, writeFile as writeFile3 } from "node:fs/promises";
import path6 from "node:path";

// src/claude-code/bridge-loop.ts
import { mkdir as mkdir2, readFile as readFile4, rename as rename2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import path5 from "node:path";

// src/core/cost-guard.ts
var COST_RISK_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
function checkEnvForApiKeys(env) {
  const foundKeys = COST_RISK_KEYS.filter((k) => (env[k] ?? "") !== "");
  return { blocked: foundKeys.length > 0, foundKeys };
}

// src/core/state-manager/atomic-json-writer.ts
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path4 from "node:path";
import { randomUUID } from "node:crypto";
var AtomicJsonWriter = class {
  filePath;
  chain = Promise.resolve();
  constructor(filePath) {
    this.filePath = filePath;
  }
  write(data) {
    this.chain = this.chain.then(
      () => this.writeOnce(data),
      () => this.writeOnce(data)
      // a prior write's failure must not permanently wedge the queue
    );
    return this.chain;
  }
  async writeOnce(data) {
    await mkdir(path4.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    try {
      await this.renameWithRetry(tmpPath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }
  /** Windows can transiently refuse to replace a file another handle has open for
   * reading (EPERM/EBUSY) even though the rename would otherwise succeed — retry a
   * few times with a short backoff rather than surfacing a spurious failure. */
  async renameWithRetry(tmpPath) {
    const RETRYABLE = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmpPath, this.filePath);
        return;
      } catch (err) {
        const code = err.code;
        if (attempt >= 15 || !code || !RETRYABLE.has(code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  }
};

// src/prompts/templates.ts
var checklistLines = (items) => items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`);
function buildChatReportContract(checklist = null) {
  return [
    "AI_BRIDGE_REVIEW_LOOP",
    "The AI Bridge review loop is on for this session: each time you finish a turn, Codex",
    "reviews your final message and decides what you do next, until it says DONE.",
    "",
    "End every final message with these two parts, in this order.",
    "",
    "1. A summary for the user, in Vietnamese, starting with the line **T\xF3m t\u1EAFt cho b\u1EA1n**:",
    "   - Vi\u1EC7c: the task in one plain sentence (rewrite it; do not paste the user's words)",
    '   - Ti\u1EBFn \u0111\u1ED9: X/Y ph\u1EA7n xong, then one line per part: "\u2713 <part>" when done and verified,',
    '     "\u2717 <part> \u2014 <what is missing>" otherwise',
    "   - V\xF2ng n\xE0y \u0111\xE3 l\xE0m: one to three short points",
    '   - C\u1EA7n b\u1EA1n: what the user must do or decide, or "Kh\xF4ng c\xF3"',
    ...checklist && checklist.length > 0 ? ["   Codex's checklist (use exactly these parts, in this order; tick what is now done):", ...checklistLines(checklist).map((l) => `   ${l}`)] : ["   Until Codex sends its checklist, break the task into 3 to 7 parts yourself."],
    "",
    "2. The report for the reviewer (each heading exactly once, in this order):",
    "",
    "## TASK",
    "## CHANGES",
    "## TESTS",
    "## ISSUES",
    "## NEXT_RECOMMENDATION",
    "NEXT_ACTION: CONTINUE, DONE, or NEED_HUMAN",
    "",
    "Rules:",
    "- Do not stop to ask questions: do the work. If a human decision is really needed, say",
    "  what under ## ISSUES (and under C\u1EA7n b\u1EA1n) and set NEXT_ACTION: NEED_HUMAN.",
    "- Describe only work you actually did. Anything not verified must be written as UNKNOWN or",
    "  NOT VERIFIED (\u2717 in the summary) \u2014 never report unverified work as done."
  ].join("\n");
}
function buildChatReviewerInput(params) {
  const keep = params.checklist && params.checklist.length > 0 ? params.checklist : null;
  return [
    "You are the senior reviewer for this project.",
    "",
    "You are the Reviewer/Architect for AI Bridge, reviewing the work Claude Code does in the",
    "user's chat session. Your job is to determine what Claude should do next, and to tell the",
    "user plainly how far the task is.",
    "",
    "Rules:",
    "",
    ...params.checkCode ? [
      "1. Check Claude's report against the project: the CHANGES below (when given) and the files",
      "   themselves. You may read the project's files and run read-only commands (git diff, git log,",
      "   ls, cat). The sandbox is read-only: do not try to write files, install anything or run the",
      "   test suite; treat the test results in the report as claims to check against the code.",
      "2. Do not invent completed work: a part is done only when the code shows it."
    ] : ["1. Review ONLY the information provided.", "2. Do not invent completed work."],
    "3. Do not modify the project yourself.",
    "4. Return exactly one AI_BRIDGE_RESPONSE block.",
    "5. Return exactly one STATUS.",
    "6. Return exactly one PROMPT.",
    "7. Preserve the PROMPT as an executable instruction for Claude Code.",
    "",
    "PROJECT:",
    params.projectName,
    "",
    "SESSION:",
    params.sessionId,
    "",
    "ITERATION:",
    String(params.iteration),
    "",
    "ROUND LIMIT:",
    String(params.maxRounds),
    "",
    "ORIGINAL TASK (as the user typed it):",
    "--- BEGIN TASK ---",
    params.task,
    "--- END TASK ---",
    "",
    ...keep ? ["YOUR CHECKLIST FROM THE PREVIOUS ROUND:", ...checklistLines(keep), ""] : [],
    ...params.humanReply ? ["THE USER'S ANSWER TO YOUR LAST QUESTION:", "--- BEGIN ANSWER ---", params.humanReply, "--- END ANSWER ---", ""] : [],
    ...params.checkCode && params.changes ? ["CHANGES IN THE PROJECT SINCE THE LOOP STARTED (git, gathered by AI Bridge):", "--- BEGIN CHANGES ---", params.changes, "--- END CHANGES ---", ""] : [],
    "CLAUDE REPORT:",
    "--------------------------------",
    "",
    "--- BEGIN REPORT ---",
    "",
    params.reportText,
    "",
    "--- END REPORT ---",
    "",
    "--------------------------------",
    "",
    "First write a short review for the user, in Vietnamese, in Markdown, OUTSIDE the response",
    "block and without any XML-style tags, with exactly these headings, in this order:",
    "",
    "## Vi\u1EC7c",
    "One plain sentence: what the user asked for (rewrite the ORIGINAL TASK clearly; do not quote it).",
    "",
    "## Ti\u1EBFn \u0111\u1ED9",
    'The task as 3 to 7 concrete parts, one line each: "- [x] <part>" when the report shows it done',
    'and verified, "- [ ] <part>" otherwise. Unverified work is not done.',
    keep ? "Keep the parts of that checklist, same wording, same order; add a part only if the task truly needs it." : "Make the list from the ORIGINAL TASK, not from the report, and keep it the same in later rounds.",
    "",
    "## K\u1EBFt lu\u1EADn",
    "One sentence for the user: is the task finished and approved, and if not, what is missing.",
    "",
    "## V\u1EA5n \u0111\u1EC1",
    'The problems found, or "Kh\xF4ng c\xF3".',
    "",
    "## Vi\u1EC7c ti\u1EBFp theo",
    "What Claude, or the user, should do next.",
    "",
    "Then return the response block using exactly this structure:",
    "",
    "<AI_BRIDGE_RESPONSE>",
    "",
    "<STATUS>",
    "CONTINUE",
    "</STATUS>",
    "",
    "<PROMPT>",
    "Exact instruction for Claude Code goes here.",
    "</PROMPT>",
    "",
    "</AI_BRIDGE_RESPONSE>",
    "",
    "Allowed STATUS values:",
    "",
    "CONTINUE",
    "DONE",
    "NEED_HUMAN",
    "",
    "Use DONE only when every part of ## Ti\u1EBFn \u0111\u1ED9 is [x]. When a part needs the user (a decision,",
    "a manual check), use NEED_HUMAN and say what in the PROMPT.",
    ""
  ].join("\n");
}

// src/reports/codex-response-parser.ts
import { createHash } from "node:crypto";
var OPEN = "<AI_BRIDGE_RESPONSE>";
var CLOSE = "</AI_BRIDGE_RESPONSE>";
var STATUSES = ["CONTINUE", "DONE", "NEED_HUMAN"];
var CodexResponseParser = class {
  parse(raw) {
    const sha256 = createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
    const fail = (errors2) => ({ valid: false, errors: errors2, status: null, prompt: null, raw, sha256 });
    const opens = countOccurrences(raw, OPEN);
    const closes = countOccurrences(raw, CLOSE);
    if (opens === 0 && closes === 0) return fail([issue("NO_RESPONSE_BLOCK", "No <AI_BRIDGE_RESPONSE> block found")]);
    if (opens > 1 || closes > 1) return fail([issue("MULTIPLE_RESPONSE_BLOCKS", `Found ${opens} opening and ${closes} closing <AI_BRIDGE_RESPONSE> tags`)]);
    const openAt = raw.indexOf(OPEN);
    const closeAt = raw.indexOf(CLOSE);
    if (opens !== 1 || closes !== 1 || closeAt < openAt + OPEN.length) {
      return fail([issue("MALFORMED_RESPONSE_BLOCK", "The <AI_BRIDGE_RESPONSE> block is not well-formed")]);
    }
    const before = raw.slice(0, openAt);
    const after = raw.slice(closeAt + CLOSE.length);
    const outsideTagPattern = /<\/?(AI_BRIDGE_RESPONSE|STATUS|PROMPT)>/;
    if (outsideTagPattern.test(before) || outsideTagPattern.test(after)) {
      return fail([issue("TAG_OUTSIDE_BLOCK", "Found a STATUS/PROMPT/AI_BRIDGE_RESPONSE tag outside the response block")]);
    }
    const body = raw.slice(openAt + OPEN.length, closeAt);
    const errors = [];
    const status = extractStatus(body, errors);
    const prompt = extractPrompt(body, errors);
    return { valid: errors.length === 0, errors, status: errors.length === 0 ? status : null, prompt: errors.length === 0 ? prompt : null, raw, sha256 };
  }
};
function issue(code, message) {
  return { code, message };
}
function countOccurrences(text, needle) {
  let count = 0;
  let from = 0;
  for (; ; ) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}
function locateTagPair(body, openTag, closeTag, missingCode, multipleCode, malformedCode, errors) {
  const opens = countOccurrences(body, openTag);
  const closes = countOccurrences(body, closeTag);
  if (opens === 0 && closes === 0) {
    errors.push(issue(missingCode, `Missing ${openTag} tag`));
    return null;
  }
  if (opens > 1 || closes > 1) {
    errors.push(issue(multipleCode, `Found ${opens} ${openTag} and ${closes} ${closeTag} tags`));
    return null;
  }
  if (opens !== 1 || closes !== 1) {
    errors.push(issue(malformedCode, `The ${openTag} tag is not well-formed`));
    return null;
  }
  const openAt = body.indexOf(openTag);
  const closeAt = body.indexOf(closeTag);
  if (closeAt < openAt + openTag.length) {
    errors.push(issue(malformedCode, `The ${openTag} tag is not well-formed`));
    return null;
  }
  return { openAt, closeAt };
}
function extractStatus(body, errors) {
  const loc = locateTagPair(body, "<STATUS>", "</STATUS>", "MISSING_STATUS", "MULTIPLE_STATUS", "MISSING_STATUS", errors);
  if (!loc) return null;
  const value = body.slice(loc.openAt + "<STATUS>".length, loc.closeAt).trim();
  if (!STATUSES.includes(value)) {
    errors.push(issue("INVALID_STATUS", `Invalid STATUS: "${value}"`));
    return null;
  }
  return value;
}
function extractPrompt(body, errors) {
  const loc = locateTagPair(body, "<PROMPT>", "</PROMPT>", "MISSING_PROMPT", "MULTIPLE_PROMPT", "MALFORMED_PROMPT", errors);
  if (!loc) return null;
  let inner = body.slice(loc.openAt + "<PROMPT>".length, loc.closeAt);
  inner = inner.replace(/^\r\n|^\n/, "").replace(/\r\n$|\n$/, "");
  if (inner.trim() === "") {
    errors.push(issue("EMPTY_PROMPT", "PROMPT must not be empty"));
    return null;
  }
  return inner;
}

// src/claude-code/progress.ts
var CHECKLIST_LINE = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/;
function sections(review) {
  const found = /* @__PURE__ */ new Map();
  let lines = null;
  for (const line of review.split("<AI_BRIDGE_RESPONSE>")[0].split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) found.set(heading[1].normalize("NFC").toLowerCase(), lines = []);
    else lines?.push(line);
  }
  return found;
}
var firstLine = (lines) => lines?.map((l) => l.trim()).find((l) => l !== "") ?? null;
function parseReviewProgress(review) {
  const s = sections(review);
  const items = [];
  for (const line of s.get("ti\u1EBFn \u0111\u1ED9") ?? []) {
    const m = CHECKLIST_LINE.exec(line);
    if (m) items.push({ text: m[2], done: m[1] !== " " });
  }
  const verdict = firstLine(s.get("k\u1EBFt lu\u1EADn"));
  if (items.length === 0 && verdict === null) return null;
  return { title: firstLine(s.get("vi\u1EC7c")), items, verdict };
}

// src/claude-code/transcript.ts
import { readFile as readFile3 } from "node:fs/promises";
var blocks = (r) => Array.isArray(r.message?.content) ? r.message.content : [];
async function readTranscript(transcriptPath) {
  const text = await readFile3(transcriptPath, "utf8");
  const records = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
    }
  }
  return records;
}
function finalReply(records) {
  const main = records.filter((r) => !r.isSidechain && (r.type === "user" || r.type === "assistant"));
  const last = main.at(-1);
  if (last?.type !== "assistant") return null;
  const id = last.message?.id;
  const parts = id === void 0 ? [last] : main.filter((r) => r.type === "assistant" && r.message?.id === id);
  const texts = parts.flatMap((r) => blocks(r).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text));
  return texts.length > 0 ? texts.join("\n") : null;
}

// src/claude-code/bridge-loop.ts
var MAX_ROUNDS = 10;
var CONTINUE_ROUNDS = 3;
var ROUNDS_LIMIT = 30;
var TRANSCRIPT_READS = 4;
var BRIDGE_COMMAND = /^\/(?:ai-bridge:)?bridge(?=\s|$)([\s\S]*)$/;
var isPlainId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
var statePath = (root, sessionId) => path5.join(root, sessionId, "state.json");
var loopDir = (root, s) => path5.join(root, s.sessionId, `loop-${s.loop}`);
async function loadLoopState(root, sessionId) {
  try {
    return JSON.parse(await readFile4(statePath(root, sessionId), "utf8"));
  } catch {
    return null;
  }
}
function saveLoopState(root, state) {
  return new AtomicJsonWriter(statePath(root, state.sessionId)).write(state);
}
var accountPath = (root) => path5.join(root, "codex-account.json");
async function loadKnownAccount(root) {
  try {
    return JSON.parse(await readFile4(accountPath(root), "utf8"));
  } catch {
    return null;
  }
}
function parseBridgeArg(arg) {
  const o = /^--(?:vong|vòng|rounds)(?=\s|$)\s*(\S*)\s*([\s\S]*)$/.exec(arg.normalize("NFC"));
  if (!o) return { rounds: null, text: arg };
  const rounds = Number(o[1]);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > ROUNDS_LIMIT) {
    return { refused: `AI Bridge: --vong takes a number of rounds from 1 to ${ROUNDS_LIMIT}, e.g. \`/bridge --vong 3 fix the login bug\`.` };
  }
  const text = (o[2] ?? "").trim();
  if (text === "") return { refused: "AI Bridge: give the task after the number of rounds, e.g. `/bridge --vong 3 fix the login bug`." };
  return { rounds, text };
}
async function handlePrompt(input, deps2) {
  if (!isPlainId(input.session_id)) return null;
  const m = BRIDGE_COMMAND.exec((input.prompt ?? "").trim());
  if (!m) return null;
  const arg = m[1].trim();
  const prev = await loadLoopState(deps2.stateRoot, input.session_id);
  const at = deps2.now().toISOString();
  if (arg === "") return { decision: "block", reason: "AI Bridge: give the task, e.g. `/bridge fix the login bug`, or `/bridge stop` to end the loop." };
  if (arg === "stop") {
    if (prev?.status !== "RUNNING" && prev?.status !== "NEED_HUMAN") return { decision: "block", reason: "AI Bridge: no review loop is running in this session." };
    await saveLoopState(deps2.stateRoot, { ...prev, status: "STOPPED", reviewingSince: null, humanReply: null, updatedAt: at });
    return {
      decision: "block",
      reason: prev.status === "NEED_HUMAN" ? "AI Bridge: the review loop that was waiting for you is ended; `/bridge <task>` starts a new one." : `AI Bridge: review loop stopped after ${prev.round} round(s).`
    };
  }
  const parsed = parseBridgeArg(arg);
  if ("refused" in parsed) return { decision: "block", reason: parsed.refused };
  if (prev?.status === "NEED_HUMAN") {
    const maxRounds = parsed.rounds !== null ? prev.round + parsed.rounds : prev.round >= prev.maxRounds ? prev.round + CONTINUE_ROUNDS : prev.maxRounds;
    await saveLoopState(deps2.stateRoot, { ...prev, status: "RUNNING", maxRounds, humanReply: parsed.text, reviewingSince: null, error: null, updatedAt: at });
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [continuation(prev, parsed.text), "", buildChatReportContract(prev.progress?.items ?? null)].join("\n")
      }
    };
  }
  await saveLoopState(deps2.stateRoot, {
    sessionId: input.session_id,
    projectPath: input.cwd,
    task: parsed.text,
    status: "RUNNING",
    loop: (prev?.loop ?? 0) + 1,
    round: 0,
    maxRounds: parsed.rounds ?? MAX_ROUNDS,
    codexThreadId: null,
    reviewingSince: null,
    lastVerdict: null,
    progress: null,
    baseCommit: await deps2.headCommit?.(input.cwd).catch(() => null) ?? null,
    humanReply: null,
    error: null,
    armedAt: at,
    updatedAt: at
  });
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: buildChatReportContract() } };
}
function continuation(prev, answer) {
  return [
    `This continues the AI Bridge review loop on the task: ${prev.task}`,
    `After review round ${prev.round}, Codex stopped and asked the user:`,
    prev.lastVerdict?.prompt ?? "(no question recorded)",
    "",
    `The user's answer (the text after /bridge in their message): ${answer}`,
    "Carry on with the task using that answer; Codex reviews your work again when you finish."
  ].join("\n");
}
async function readReply(input, retryMs) {
  if (input.last_assistant_message?.trim()) return input.last_assistant_message;
  for (let i = 1; ; i++) {
    const reply = finalReply(await readTranscript(input.transcript_path).catch(() => []));
    if (reply?.trim()) return reply;
    if (i >= TRANSCRIPT_READS || retryMs === 0) return null;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
async function handleStop(input, deps2) {
  if (!isPlainId(input.session_id)) return null;
  const state = await loadLoopState(deps2.stateRoot, input.session_id);
  if (state?.status !== "RUNNING") return null;
  const end = async (status, message2, patch2 = {}) => {
    await saveLoopState(deps2.stateRoot, { ...state, ...patch2, status, reviewingSince: null, updatedAt: deps2.now().toISOString() });
    if (!/^(off|0|false|no)$/i.test(deps2.env.AI_BRIDGE_NOTIFY ?? "")) await deps2.notify?.("AI Bridge", clip(message2.replace(/^AI Bridge(?: ·|:) /, ""), 500));
    return { systemMessage: message2 };
  };
  const fail = (error, patch2 = {}) => end("ERROR", `AI Bridge: ${error} \u2014 review loop stopped.`, { ...patch2, error });
  const keys = checkEnvForApiKeys(deps2.env);
  if (keys.blocked) return fail(`cost-risk env vars set (${keys.foundKeys.join(", ")})`);
  const reply = await readReply(input, deps2.transcriptRetryMs ?? 500);
  if (reply === null) return fail("no final message from Claude to review");
  const codex = await deps2.locateCodex();
  if (codex === null) return fail("Codex CLI not found (PATH or %LOCALAPPDATA%\\OpenAI\\Codex\\bin)");
  const round = state.round + 1;
  const nnn = String(round).padStart(3, "0");
  const dir = loopDir(deps2.stateRoot, state);
  await mkdir2(dir, { recursive: true });
  await setAsideInterrupted(dir, nnn, state.reviewingSince ?? deps2.now().toISOString());
  await writeFile2(path5.join(dir, `${nnn}-report.md`), reply, "utf8");
  const account = state.codexAccount ?? await loadKnownAccount(deps2.stateRoot);
  const checkCode = shouldCheckCode(checkCodeMode(deps2.env), account);
  const reviewerInput = buildChatReviewerInput({
    projectName: path5.basename(state.projectPath),
    sessionId: state.sessionId,
    iteration: round,
    reportText: reply,
    task: state.task,
    maxRounds: state.maxRounds,
    checklist: state.progress?.items ?? null,
    checkCode,
    changes: checkCode ? await deps2.changesSince?.(state.projectPath, state.baseCommit ?? null).catch(() => null) ?? null : null,
    humanReply: state.humanReply ?? null
  });
  await writeFile2(path5.join(dir, `${nnn}-codex-input.md`), reviewerInput, "utf8");
  await saveLoopState(deps2.stateRoot, { ...state, reviewingSince: deps2.now().toISOString(), updatedAt: deps2.now().toISOString() });
  const result = await codex.run({
    cwd: state.projectPath,
    input: reviewerInput,
    threadId: state.codexThreadId,
    outputPath: path5.join(dir, `${nnn}-codex-review.md`),
    timeoutMs: deps2.codexTimeoutMs,
    env: deps2.env
  });
  const current = await loadLoopState(deps2.stateRoot, state.sessionId);
  if (current?.status !== "RUNNING" || current.loop !== state.loop) return null;
  if (!result.ok) return fail(`Codex review failed (${result.errorCode})`, { round });
  const parsed = new CodexResponseParser().parse(result.responseText ?? "");
  if (!parsed.valid || parsed.status === null || parsed.prompt === null) {
    return fail(`Codex response not usable (${parsed.errors.map((e) => e.code).join(", ")})`, { round, codexThreadId: result.threadId });
  }
  const progress = parseReviewProgress(result.responseText ?? "") ?? state.progress ?? null;
  const fresh = result.threadId ? await deps2.codexAccount?.(result.threadId).catch(() => null) ?? null : null;
  if (fresh) await new AtomicJsonWriter(accountPath(deps2.stateRoot)).write(fresh).catch(() => void 0);
  const codexAccount = fresh ?? account;
  const patch = {
    round,
    codexThreadId: result.threadId,
    lastVerdict: { round, status: parsed.status, prompt: parsed.prompt },
    progress,
    humanReply: null,
    codexAccount,
    checksCode: checkCode,
    error: null
  };
  const quota = quotaLine(codexAccount, checkCode, deps2.now().getTime());
  const message = (verdict, next) => roundMessage(round, state.maxRounds, verdict, progress, quota === null ? next : `${next}
${quota}`);
  if (parsed.status === "DONE") return end("DONE", message(VERDICT_WORDS.DONE, `Xong sau ${round} v\xF2ng review, v\xF2ng l\u1EB7p k\u1EBFt th\xFAc.`), patch);
  if (parsed.status === "NEED_HUMAN") return end("NEED_HUMAN", message(VERDICT_WORDS.NEED_HUMAN, `\u2192 Codex c\u1EA7n b\u1EA1n: ${parsed.prompt}`), patch);
  if (round >= state.maxRounds) {
    return end("NEED_HUMAN", message("\u23F8 \u0110\xE3 h\u1EBFt s\u1ED1 v\xF2ng", `Codex ch\u01B0a duy\u1EC7t; v\xF2ng l\u1EB7p d\u1EEBng \u1EDF \u0111\xE2y. Ch\u1EC9 d\u1EABn Codex \u0111\u1ECBnh g\u1EEDi ti\u1EBFp:
${parsed.prompt}`), patch);
  }
  await saveLoopState(deps2.stateRoot, { ...state, ...patch, reviewingSince: null, updatedAt: deps2.now().toISOString() });
  return {
    decision: "block",
    reason: [
      `AI Bridge \u2014 Codex review, round ${round}: CONTINUE. Next instruction:`,
      "",
      parsed.prompt,
      "",
      acknowledgeReview(round),
      "",
      buildChatReportContract(progress?.items ?? null)
    ].join("\n"),
    systemMessage: message(VERDICT_WORDS.CONTINUE, "\u2192 Claude l\xE0m ti\u1EBFp theo ch\u1EC9 d\u1EABn c\u1EE7a Codex.")
  };
}
var ROUND_FILES = ["report.md", "codex-input.md", "codex-review.md"];
async function setAsideInterrupted(dir, nnn, since) {
  const stamp = since.replace(/:/g, "-");
  for (const name of ROUND_FILES) {
    const from = path5.join(dir, `${nnn}-${name}`);
    if (!await stat2(from).then(() => true, () => false)) continue;
    await mkdir2(path5.join(dir, "interrupted"), { recursive: true });
    await rename2(from, path5.join(dir, "interrupted", `${nnn}-${stamp}-${name}`));
  }
}
var clip = (text, max) => text.length > max ? `${text.slice(0, max)}\u2026` : text;
var windowWords = (minutes) => minutes % 1440 === 0 ? `${minutes / 1440} ng\xE0y` : minutes % 60 === 0 ? `${minutes / 60} gi\u1EDD` : `${minutes} ph\xFAt`;
function quotaLine(account, checkCode, nowMs) {
  if (account === null || account.plan === null && account.usedPercent === null) return null;
  const parts = [account.plan ? `Codex ${account.plan}` : "Codex"];
  if (account.usedPercent !== null) {
    parts.push(`\u0111\xE3 d\xF9ng ${Math.round(account.usedPercent)}% h\u1EA1n m\u1EE9c${account.windowMinutes ? ` ${windowWords(account.windowMinutes)}` : ""}`);
  }
  const left = account.resetsAt !== null ? account.resetsAt * 1e3 - nowMs : 0;
  if (left > 0) parts.push(`\u0111\u1EB7t l\u1EA1i sau ${left >= 864e5 ? `${Math.ceil(left / 864e5)} ng\xE0y` : `${Math.ceil(left / 36e5)} gi\u1EDD`}`);
  parts.push(checkCode ? "Codex ki\u1EC3m tra c\u1EA3 code" : "Codex ch\u1EC9 \u0111\u1ECDc b\xE1o c\xE1o");
  return parts.join(" \xB7 ");
}
var VERDICT_WORDS = {
  CONTINUE: "Codex: ch\u01B0a duy\u1EC7t, Claude l\xE0m ti\u1EBFp",
  DONE: "\u2705 Codex \u0111\xE3 duy\u1EC7t",
  NEED_HUMAN: "\u23F8 Codex c\u1EA7n b\u1EA1n"
};
function roundMessage(round, maxRounds, verdict, progress, next) {
  const items = progress?.items ?? [];
  const count = items.length > 0 ? ` \xB7 ${items.filter((i) => i.done).length}/${items.length} ph\u1EA7n xong` : "";
  return [
    `AI Bridge \xB7 v\xF2ng ${round}/${maxRounds} \xB7 ${verdict}${count}`,
    ...progress?.verdict ? [progress.verdict] : [],
    ...items.map((i) => `${i.done ? "\u2713" : "\u2717"} ${i.text}`),
    next
  ].join("\n");
}
function acknowledgeReview(round) {
  return `Begin your reply with one short line, in the user's language, telling the user you received Codex's round ${round} review and what you will do next (for example: "\u0110\xE3 nh\u1EADn review v\xF2ng ${round} c\u1EE7a Codex (CONTINUE) \u2014 ti\u1EBFp theo t\xF4i s\u1EBD \u2026").`;
}

// src/chat-hosts/antigravity/transcript.ts
import { readFile as readFile5 } from "node:fs/promises";
async function readSteps(transcriptPath) {
  const steps = [];
  for (const line of (await readFile5(transcriptPath, "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    try {
      steps.push(JSON.parse(line));
    } catch {
    }
  }
  return steps;
}
var USER_REQUEST = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/;
function lastUserRequest(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type !== "USER_INPUT" || s.source !== "USER_EXPLICIT" || typeof s.content !== "string") continue;
    return { stepIndex: s.step_index ?? i, text: (USER_REQUEST.exec(s.content)?.[1] ?? s.content).trim() };
  }
  return null;
}
function finalReply2(steps) {
  const last = steps.at(-1);
  if (last?.source !== "MODEL" || last.type !== "PLANNER_RESPONSE") return null;
  if (last.status !== void 0 && last.status !== "DONE") return null;
  if (Array.isArray(last.tool_calls) && last.tool_calls.length > 0) return null;
  return typeof last.content === "string" && last.content.trim() !== "" ? last.content : null;
}

// src/chat-hosts/antigravity/hooks.ts
var READS = 4;
var BRIDGE_COMMAND2 = /^\/(?:ai-bridge:)?bridge(?=\s|$)/;
var conversationOf = (i) => typeof i.conversationId === "string" && /^[A-Za-z0-9_-]+$/.test(i.conversationId) ? i.conversationId : null;
var cwdOf = (i) => i.workspacePaths?.find((p) => typeof p === "string" && p !== "") ?? process.cwd();
var pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var cursorPath = (root, conversation) => path6.join(root, conversation, "prompt-cursor.json");
async function loadCursor(root, conversation) {
  try {
    const v = JSON.parse(await readFile6(cursorPath(root, conversation), "utf8")).stepIndex;
    return typeof v === "number" ? v : -1;
  } catch {
    return -1;
  }
}
async function saveCursor(root, conversation, stepIndex) {
  await mkdir3(path6.join(root, conversation), { recursive: true });
  await writeFile3(cursorPath(root, conversation), JSON.stringify({ stepIndex }), "utf8");
}
var answerToUser = (message) => `The user typed an AI Bridge command, and AI Bridge answered it: "${message}". Reply with exactly that message, in one short line, and do nothing else: do not start a task, do not use any tool.`;
var injected = (text) => ({ injectSteps: [{ systemMessage: { systemMessage: text } }] });
async function handlePreInvocation(input, deps2) {
  const conversation = conversationOf(input);
  if (conversation === null || input.invocationNum !== 0 || !input.transcriptPath) return null;
  let request = null;
  for (let i = 1; i <= READS; i++) {
    const steps = await readSteps(input.transcriptPath).catch(() => []);
    request = lastUserRequest(steps);
    if (steps.length >= (input.initialNumSteps ?? 0) || i === READS || (deps2.retryMs ?? 300) === 0) break;
    await pause(deps2.retryMs ?? 300);
  }
  if (request === null || !BRIDGE_COMMAND2.test(request.text)) return null;
  if (request.stepIndex <= await loadCursor(deps2.stateRoot, conversation)) return null;
  await saveCursor(deps2.stateRoot, conversation, request.stepIndex);
  const out = await handlePrompt({ session_id: conversation, cwd: cwdOf(input), prompt: request.text }, { stateRoot: deps2.stateRoot, now: deps2.now, headCommit: deps2.headCommit });
  if (out === null) return null;
  if (out.decision === "block") return injected(answerToUser(out.reason ?? "AI Bridge"));
  const context = out.hookSpecificOutput?.additionalContext;
  return context ? injected(context) : null;
}
async function readReply2(transcriptPath, retryMs) {
  if (!transcriptPath) return null;
  for (let i = 1; ; i++) {
    const reply = finalReply2(await readSteps(transcriptPath).catch(() => []));
    if (reply !== null) return reply;
    if (i >= READS || retryMs === 0) return null;
    await pause(retryMs);
  }
}
var block = (message) => `---
${message}
---`;
async function handleAgyStop(input, deps2) {
  const conversation = conversationOf(input);
  if (conversation === null || input.fullyIdle === false || input.error) return null;
  const state = await loadLoopState(deps2.stateRoot, conversation);
  if (state?.status !== "RUNNING") return null;
  const reply = await readReply2(input.transcriptPath, deps2.retryMs ?? 300);
  const out = await handleStop(
    { session_id: conversation, cwd: state.projectPath, transcript_path: "", last_assistant_message: reply ?? "" },
    { ...deps2, transcriptRetryMs: 0 }
  );
  if (out === null) return null;
  if (out.decision === "block") {
    const status = out.systemMessage ? `AI Bridge status for the user: start your reply with the block below, exactly as written.
${block(out.systemMessage)}

` : "";
    return { decision: "continue", reason: `${status}${out.reason ?? ""}` };
  }
  if (!out.systemMessage) return null;
  return {
    decision: "continue",
    reason: `The AI Bridge review loop has ended. Reply with the block below exactly as written and nothing else: do not use any tool, do not continue the task.
${block(out.systemMessage)}`
  };
}

// src/chat-hosts/antigravity/hook-entry.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
var deps = { stateRoot: stateRootOf("antigravity", "AI_BRIDGE_ANTIGRAVITY_DIR"), now: () => /* @__PURE__ */ new Date(), ...realReviewDeps() };
var kind = process.argv[2];
try {
  const input = JSON.parse(await readStdin());
  if (kind === "pre") process.stdout.write(JSON.stringify(await handlePreInvocation(input, deps) ?? {}));
  else if (kind === "stop") process.stdout.write(JSON.stringify(await handleAgyStop(input, deps) ?? { decision: "allow" }));
  else throw new Error(`unknown hook kind ${JSON.stringify(kind)}`);
} catch (err) {
  process.stderr.write(`AI Bridge hook error: ${err instanceof Error ? err.message : String(err)}
`);
  process.stdout.write(JSON.stringify(kind === "stop" ? { decision: "allow" } : {}));
}
process.exitCode = 0;
