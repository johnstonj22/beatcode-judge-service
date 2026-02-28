const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 5050);
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 2000);
const MAX_TIMEOUT_MS = Number(process.env.MAX_TIMEOUT_MS || 5000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 60);

app.use(express.json({ limit: "1mb" }));

const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = rateBuckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: "Too many requests" });
  }

  bucket.count += 1;
  return next();
}

function clampTimeout(timeoutMs) {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

function normalizeOutput(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

function runProcess(command, args, options = {}) {
  const { cwd, stdin = "", timeoutMs = 3000 } = options;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        exitCode: 1,
        timeMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: timedOut ? `${stderr}\nTime limit exceeded` : stderr,
        exitCode: timedOut ? 124 : code ?? 1,
        timeMs: Date.now() - startedAt,
      });
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

async function executeSubmission({ language, code, stdin, timeoutMs }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "beatcode-judge-"));

  try {
    if (language === "javascript") {
      const file = path.join(tempDir, "main.js");
      await fs.writeFile(file, code, "utf8");
      return runProcess("node", [file], { cwd: tempDir, stdin, timeoutMs });
    }

    if (language === "python") {
      const file = path.join(tempDir, "main.py");
      await fs.writeFile(file, code, "utf8");
      return runProcess("python3", [file], { cwd: tempDir, stdin, timeoutMs });
    }

    if (language === "cpp") {
      const src = path.join(tempDir, "main.cpp");
      const bin = path.join(tempDir, "main");

      await fs.writeFile(src, code, "utf8");

      const compile = await runProcess("g++", [src, "-O2", "-std=c++17", "-o", bin], {
        cwd: tempDir,
        timeoutMs,
      });

      if (compile.exitCode !== 0) {
        return { ...compile, phase: "compile" };
      }

      const runResult = await runProcess(bin, [], { cwd: tempDir, stdin, timeoutMs });
      return { ...runResult, phase: "run" };
    }

    return {
      stdout: "",
      stderr: `Unsupported language: ${language}`,
      exitCode: 2,
      timeMs: 0,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(rateLimit);

app.post("/run", async (req, res) => {
  const { language, code, stdin = "", timeoutMs } = req.body || {};
  const effectiveTimeoutMs = clampTimeout(timeoutMs);

  if (!language || !code) {
    return res.status(400).json({ error: "language and code are required" });
  }

  try {
    const result = await executeSubmission({
      language,
      code,
      stdin,
      timeoutMs: effectiveTimeoutMs,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: "Runner failed", details: String(err.message || err) });
  }
});

app.post("/judge", async (req, res) => {
  const { language, code, testCases = [], timeoutMs } = req.body || {};
  const effectiveTimeoutMs = clampTimeout(timeoutMs);

  if (!language || !code || !Array.isArray(testCases)) {
    return res.status(400).json({ error: "language, code, and testCases[] are required" });
  }

  try {
    for (let i = 0; i < testCases.length; i += 1) {
      const test = testCases[i] || {};
      const input = String(test.input || "");
      const expectedOutput = String(test.expectedOutput || "");

      const result = await executeSubmission({
        language,
        code,
        stdin: input,
        timeoutMs: effectiveTimeoutMs,
      });
      if (result.exitCode !== 0) {
        return res.status(200).json({
          passed: false,
          failedAt: i,
          reason: "runtime_or_compile_error",
          result,
        });
      }

      const actual = normalizeOutput(result.stdout);
      const expected = normalizeOutput(expectedOutput);

      if (actual !== expected) {
        return res.status(200).json({
          passed: false,
          failedAt: i,
          reason: "wrong_answer",
          expected,
          actual,
          result,
        });
      }
    }

    return res.status(200).json({ passed: true });
  } catch (err) {
    return res.status(500).json({ error: "Judge failed", details: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Judge service listening on port ${PORT}`);
});
