const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 5050);
const EXEC_ROOT = process.env.JUDGE_EXEC_ROOT || process.cwd();
const DEBUG_JUDGE = process.env.JUDGE_DEBUG === "1" || process.env.JUDGE_DEBUG === "true";
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 2000);
const MAX_TIMEOUT_MS = Number(process.env.MAX_TIMEOUT_MS || 5000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 60);

app.use(express.json({ limit: "1mb" }));

const rateBuckets = new Map();

function debug(...items) {
  if (!DEBUG_JUDGE) return;
  console.log("[judge-debug]", ...items);
}

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

function preprocessPythonCodeForJudge(code, functionName) {
  const normalized = String(code || "");
  if (!normalized.includes("def")) {
    return normalized;
  }

  if (!normalized.includes("class")) return normalized;

  const lines = normalized.split("\n");
  const methodLineIndex = lines.findIndex((line) => new RegExp(`^\\s*def\\s+${functionName}\\s*\\(`).test(line));
  if (methodLineIndex === -1) return normalized;

  const methodIndent = (lines[methodLineIndex].match(/^(\s*)/) || [""])[1].length;
  const methodLines = [];

  for (let i = methodLineIndex; i < lines.length; i++) {
    const current = lines[i];
    const isBlank = current.trim() === "";
    const indent = (current.match(/^(\s*)/) || [""])[1].length;

    if (i > methodLineIndex && !isBlank && indent <= methodIndent && /^\s*(def|class)/.test(current)) {
      break;
    }

    methodLines.push(current);
  }

  const dedented = methodLines.map((line) => {
    if (!line.trim()) return "";
    return line.startsWith(" ".repeat(methodIndent)) ? line.slice(methodIndent) : line;
  });

  const merged = dedented.join("\n");
  const noSelf = merged.replace(
    new RegExp(`def\\s+${functionName}\\s*\\(\\s*(?:self|cls)\\s*(?:,\\s*)?`),
    `def ${functionName}(`
  );

  return noSelf.trim();
}

function buildWrappedPython(code, functionName, args) {
  const safeCode = code.includes("from typing import") ? preprocessPythonCodeForJudge(code, functionName) : `from typing import *\n${preprocessPythonCodeForJudge(code, functionName)}`;
  return `${safeCode}\n\nimport json as _json\n_args = _json.loads(_json.dumps(${JSON.stringify(args || [])}))\n_result = ${functionName}(*_args)\nprint(_json.dumps(_result))\n`;
}

function buildWrappedJavascript(code, functionName, args) {
  return `${code}\n\n(async () => {\n  try {\n    const _result = await Promise.resolve(${functionName}(...${JSON.stringify(args || [])}));\n    process.stdout.write(JSON.stringify(_result) + "\\n");\n  } catch (err) {\n    process.stderr.write(String(err) + "\\n");\n    process.exit(1);\n  }\n})();\n`;
}

function inferCppArgType(value, depth = 0) {
  if (depth > 8) return "string";

  if (Array.isArray(value)) {
    if (value.length === 0) return "vector<long long>";

    const samples = value.filter((item) => item !== null && item !== undefined);
    const firstType = samples.length === 0 ? "long long" : inferCppArgType(samples[0], depth + 1);
    const normalizedInnerType = samples.reduce((acc, item) => mergeCppType(acc, inferCppArgType(item, depth + 1)), firstType);
    const innerType = normalizedInnerType;

    return `vector<${innerType}>`;
  }

  if (value === null || value === undefined) return "long long";

  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "long long" : "double";
  if (typeof value === "string") return "string";

  if (typeof value === "object") {
    return "string";
  }

  return "string";
}

function isNumericCppType(type) {
  return type === "long long" || type === "double";
}

function mergeCppType(existingType, nextType) {
  if (existingType === nextType) return nextType;
  if (existingType === undefined) return nextType;

  if (isNumericCppType(existingType) && isNumericCppType(nextType)) return "double";

  return "string";
}

function isLikelyObjectLiteral(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeCppLiteral(value) {
  if (Array.isArray(value)) {
    const rendered = value.map((item) => serializeCppLiteral(item)).join(", ");
    return `{${rendered}}`;
  }

  if (value === null || value === undefined) return "0";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return `${value}`;
  if (typeof value === "string") return JSON.stringify(value);

  if (isLikelyObjectLiteral(value)) {
    const rendered = Object.entries(value)
      .map(([key, item]) => `{${JSON.stringify(key)}, ${serializeCppLiteral(item)}}`)
      .join(", ");
    return `{${rendered}}`;
  }

  return JSON.stringify(value);
}

function buildWrappedCpp(code, functionName, args) {
  const safeCode = code;
  const normalized = String(functionName || "").trim();
  const safeArgs = Array.isArray(args) ? args : [];
  const declaredArgs = safeArgs.map((arg, idx) => {
    const type = inferCppArgType(arg);
    return `${type} __arg${idx} = ${serializeCppLiteral(arg)};`;
  });

  const callSignatureArgs = safeArgs.map((_, idx) => `__arg${idx}`).join(", ");
  const isClassBased = /\bclass\s+Solution\s*:\s*public\b/.test(code) || /\bclass\s+Solution\s*{/.test(code) || /\bclass\s+Solution\b/.test(code);
  const callExpr = isClassBased
    ? `Solution __solution; __solution.${normalized}(${callSignatureArgs});`
    : `${normalized}(${callSignatureArgs});`;

  return [
    "#include <bits/stdc++.h>",
    "using namespace std;",
    "",
    safeCode,
    "",
    "template <typename T>",
    "string __json_escape(const T& value) {",
    "  std::ostringstream oss;",
    "  oss << value;",
    "  return oss.str();",
    "}",
    "",
    "string __json_escape(const string& value) {",
    "  std::ostringstream out;",
    "  out << '\"';",
    "  for (char ch : value) {",
    "    switch (ch) {",
    "      case '\\\\': out << \"\\\\\\\\\"; break;",
    "      case '\"': out << \"\\\\\\\"\"; break;",
    "      case '\\n': out << \"\\\\n\"; break;",
    "      case '\\r': out << \"\\\\r\"; break;",
    "      case '\\t': out << \"\\\\t\"; break;",
    "      default: out << ch;",
    "    }",
    "  }",
    "  out << '\"';",
    "  return out.str();",
    "}",
    "",
    "string __to_json(const bool& value) { return value ? \"true\" : \"false\"; }",
    "string __to_json(const int& value) { return to_string(value); }",
    "string __to_json(const long long& value) { return to_string(value); }",
    "string __to_json(const double& value) { std::ostringstream out; out << fixed << setprecision(12) << value; return out.str(); }",
    "string __to_json(const string& value) { return __json_escape(value); }",
    "template <typename T> string __to_json(const vector<T>& value) {",
    "  string out = \"[\";",
    "  for (size_t i = 0; i < value.size(); i += 1) {",
    "    if (i) out += \",\";",
    "    out += __to_json(value[i]);",
    "  }",
    "  return out + \"]\";",
    "}",
    "",
    "int main() {",
    "  try {",
    "    " + declaredArgs.join("\n    "),
    "    " + (normalized ? `auto __call = [&](){ return ${callExpr}; };` : ""),
    "    if constexpr (std::is_same_v<decltype(__call()), void>) {",
    "      __call();",
    "      std::cout << \"null\\n\";",
    "    } else {",
    "      auto __result = __call();",
    "      std::cout << __to_json(__result) << \"\\n\";",
    "    }",
    "  } catch (const exception& e) {",
    "    std::cerr << e.what() << \"\\n\";",
    "    return 1;",
    "  }",
    "  return 0;",
    "}",
  ].join("\n");
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
  const reqId = Math.random().toString(36).slice(2, 10);
  debug("executeSubmission start", { reqId, language, timeoutMs });

  await fs.mkdir(path.join(EXEC_ROOT, ".judge-tmp"), { recursive: true }).catch(() => {});
  const tempDir = await fs.mkdtemp(path.join(EXEC_ROOT, ".judge-tmp", "beatcode-judge-"));
  debug("tempDir created", { reqId, tempDir });

  try {
    if (language === "javascript") {
      const file = path.join(tempDir, "main.js");
      await fs.writeFile(file, code, "utf8");
      try {
        await fs.access(file);
      } catch {
        debug("writeCheck failed", { reqId, file });
        return {
          stdout: "",
          stderr: `Failed to write JavaScript source file to ${file}`,
          exitCode: 2,
          timeMs: 0,
        };
      }
      debug("runCommand", { reqId, command: "node", file, cwd: tempDir });
      const result = await runProcess("node", [file], { cwd: tempDir, stdin, timeoutMs });
      debug("runComplete", { reqId, exitCode: result.exitCode, timeMs: result.timeMs });
      return result;
    }

    if (language === "python") {
      const file = path.join(tempDir, "main.py");
      await fs.writeFile(file, code, "utf8");
      try {
        await fs.access(file);
      } catch {
        debug("writeCheck failed", { reqId, file });
        return {
          stdout: "",
          stderr: `Failed to write Python source file to ${file}`,
          exitCode: 2,
          timeMs: 0,
        };
      }
      debug("runCommand", { reqId, command: "python3", file, cwd: tempDir });
      const result = await runProcess("python3", [file], { cwd: tempDir, stdin, timeoutMs });
      debug("runComplete", { reqId, exitCode: result.exitCode, timeMs: result.timeMs });
      return result;
    }

    if (language === "cpp") {
      const src = path.join(tempDir, "main.cpp");
      const bin = path.join(tempDir, "main");

      await fs.writeFile(src, code, "utf8");

      const compile = await runProcess("g++", [src, "-O2", "-std=c++17", "-o", bin], {
        cwd: tempDir,
        timeoutMs,
      });
      debug("compileComplete", { reqId, exitCode: compile.exitCode, timeMs: compile.timeMs });

      if (compile.exitCode !== 0) {
        return { ...compile, phase: "compile" };
      }

      const runResult = await runProcess(bin, [], { cwd: tempDir, stdin, timeoutMs });
      debug("runComplete", { reqId, command: bin, exitCode: runResult.exitCode, timeMs: runResult.timeMs });
      return { ...runResult, phase: "run" };
    }

    return {
      stdout: "",
      stderr: `Unsupported language: ${language}`,
      exitCode: 2,
      timeMs: 0,
    };
  } finally {
    debug("cleanupTempDir", { reqId, tempDir });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(rateLimit);

app.post("/run", async (req, res) => {
  const { language, code, stdin = "", timeoutMs, functionName, args } = req.body || {};
  const effectiveTimeoutMs = clampTimeout(timeoutMs);

  if (!language || !code) {
    return res.status(400).json({ error: "language and code are required" });
  }

  try {
    if (typeof functionName === "string" && functionName.trim() && Array.isArray(args)) {
      let runnableCode = "";

      if (language === "javascript") {
        runnableCode = buildWrappedJavascript(code, functionName, args);
      } else if (language === "python") {
        runnableCode = buildWrappedPython(code, functionName, args);
      } else if (language === "cpp") {
        runnableCode = buildWrappedCpp(code, functionName, args);
      }

      const result = await executeSubmission({ language, code: runnableCode, stdin: "", timeoutMs: effectiveTimeoutMs });
      return res.status(200).json(result);
    }

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
  const { language, code, functionName, testCases = [], timeoutMs } = req.body || {};
  const effectiveTimeoutMs = clampTimeout(timeoutMs);

  if (!language || !code || !Array.isArray(testCases)) {
    return res.status(400).json({ error: "language, code, and testCases[] are required" });
  }

  try {
    for (let i = 0; i < testCases.length; i += 1) {
      const test = testCases[i] || {};
      const expectedOutput = String(test.expectedOutput || "");
      const expected = normalizeOutput(expectedOutput);

      if (typeof functionName === "string" && functionName.trim() && Array.isArray(test.args)) {
        const wrappedCode = language === "cpp"
          ? buildWrappedCpp(code, functionName, test.args)
          : language === "python"
          ? buildWrappedPython(code, functionName, test.args)
          : buildWrappedJavascript(code, functionName, test.args);

        const result = await executeSubmission({
          language,
          code: wrappedCode,
          stdin: "",
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
        continue;
      }

      const input = String(test.input || "");

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
