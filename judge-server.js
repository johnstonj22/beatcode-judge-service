const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 5050);
const EXEC_ROOT = process.env.JUDGE_EXEC_ROOT || process.cwd();
const DEBUG_JUDGE = process.env.JUDGE_DEBUG === "1" || process.env.JUDGE_DEBUG === "true";
const DEBUG_WRAP_ENABLED = process.env.JUDGE_DEBUG_WRAP === "1" || process.env.JUDGE_DEBUG_WRAP === "true";
const DEBUG_WRAP_TOKEN = process.env.DEBUG_WRAP_TOKEN || "";
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
function authorizeDebugWrap(req, res) {
  if (!DEBUG_WRAP_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return false;
  }

  if (DEBUG_WRAP_TOKEN) {
    const token = req.header("x-debug-token") || "";
    if (token !== DEBUG_WRAP_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
  }

  return true;
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

function shouldUseLinkedListHarness(code, functionName, argTypes) {
  const fn = String(functionName || "");
  const source = String(code || "");
  const hintedTypes = Array.isArray(argTypes) ? argTypes.join(" ") : "";
  return /\bListNode\b/.test(source) || /\bListNode\b/.test(hintedTypes) || fn === "addTwoNumbers";
}

function buildWrappedPython(code, functionName, args, argTypes) {
  const safeCode = code.includes("from typing import")
    ? preprocessPythonCodeForJudge(code, functionName)
    : `from typing import *\n${preprocessPythonCodeForJudge(code, functionName)}`;
  const useLinkedList = shouldUseLinkedListHarness(code, functionName, argTypes);

  if (!useLinkedList) {
    return `${safeCode}\n\nimport json as _json\n_args = _json.loads(_json.dumps(${JSON.stringify(args || [])}))\n_result = ${functionName}(*_args)\nprint(_json.dumps({"__judge":{"result":_result,"mutatedArgs":_args}}))\n`;
  }

  const listNodePrelude = /\bclass\s+ListNode\b/.test(safeCode)
    ? ""
    : `class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val = val\n        self.next = next\n\n`;

  return `${listNodePrelude}${safeCode}\n\nimport json as _json\n\ndef __build_list(values):\n    dummy = ListNode(0)\n    cur = dummy\n    for v in values:\n        cur.next = ListNode(v)\n        cur = cur.next\n    return dummy.next\n\ndef __list_to_array(node):\n    out = []\n    seen = 0\n    while node is not None and seen < 10000:\n        out.append(node.val)\n        node = node.next\n        seen += 1\n    return out\n\ndef __normalize_value(v):\n    if v is None:\n        return []\n    if hasattr(v, "val") and hasattr(v, "next"):\n        return __list_to_array(v)\n    return v\n\n_args = _json.loads(_json.dumps(${JSON.stringify(args || [])}))\n_adapted = [__build_list(a) if isinstance(a, list) else a for a in _args]\n_result = ${functionName}(*_adapted)\n_norm_result = __normalize_value(_result)\n_norm_args = [__normalize_value(a) for a in _adapted]\nprint(_json.dumps({"__judge":{"result":_norm_result,"mutatedArgs":_norm_args}}))\n`;
}

function buildWrappedJavascript(code, functionName, args, argTypes) {
  const useLinkedList = shouldUseLinkedListHarness(code, functionName, argTypes);

  if (!useLinkedList) {
    return `${code}\n\n(async () => {\n  try {\n    const _args = JSON.parse(JSON.stringify(${JSON.stringify(args || [])}));\n    const _result = await Promise.resolve(${functionName}(..._args));\n    process.stdout.write(JSON.stringify({ __judge: { result: _result, mutatedArgs: _args } }) + "\\n");\n  } catch (err) {\n    process.stderr.write(String(err) + "\\n");\n    process.exit(1);\n  }\n})();\n`;
  }

  const listNodePrelude = /\bclass\s+ListNode\b/.test(String(code || ""))
    ? ""
    : `class ListNode {\n  constructor(val = 0, next = null) {\n    this.val = val;\n    this.next = next;\n  }\n}\n\n`;

  return `${listNodePrelude}${code}\n\nfunction __buildList(values) {\n  const dummy = new ListNode(0);\n  let cur = dummy;\n  for (const v of values) {\n    cur.next = new ListNode(v);\n    cur = cur.next;\n  }\n  return dummy.next;\n}\n\nfunction __listToArray(node) {\n  const out = [];\n  let seen = 0;\n  while (node && seen < 10000) {\n    out.push(node.val);\n    node = node.next;\n    seen += 1;\n  }\n  return out;\n}\n\nfunction __normalizeValue(v) {\n  if (v == null) return [];\n  if (v && typeof v === \"object\" && \"val\" in v && \"next\" in v) return __listToArray(v);\n  return v;\n}\n\n(async () => {\n  try {\n    const _rawArgs = ${JSON.stringify(args || [])};\n    const _args = _rawArgs.map((a) => Array.isArray(a) ? __buildList(a) : a);\n    const _result = await Promise.resolve(${functionName}(..._args));\n    const _final = __normalizeValue(_result);\n    const _mutatedArgs = _args.map((a) => __normalizeValue(a));\n    process.stdout.write(JSON.stringify({ __judge: { result: _final, mutatedArgs: _mutatedArgs } }) + \"\\n\");\n  } catch (err) {\n    process.stderr.write(String(err) + \"\\n\");\n    process.exit(1);\n  }\n})();\n`;
}

function inferCppArgType(value, depth = 0) {
  if (depth > 8) return "string";

  if (Array.isArray(value)) {
    if (value.length === 0) return "vector<int>";

    const samples = value.filter((item) => item !== null && item !== undefined);
    const firstType = samples.length === 0 ? "int" : inferCppArgType(samples[0], depth + 1);
    const normalizedInnerType = samples.reduce((acc, item) => mergeCppType(acc, inferCppArgType(item, depth + 1)), firstType);

    return `vector<${normalizedInnerType}>`;
  }

  if (value === null || value === undefined) return "int";

  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "double";
    if (!Number.isInteger(value)) return "double";

    // Prefer int for LeetCode-style signatures; promote only when needed.
    if (value >= -2147483648 && value <= 2147483647) return "int";
    return "long long";
  }
  if (typeof value === "string") return "string";

  if (typeof value === "object") {
    return "string";
  }

  return "string";
}
function isNumericCppType(type) {
  return type === "int" || type === "long long" || type === "double";
}

function mergeCppType(existingType, nextType) {
  if (existingType === nextType) return nextType;
  if (existingType === undefined) return nextType;

  if (isNumericCppType(existingType) && isNumericCppType(nextType)) {
    if (existingType === "double" || nextType === "double") return "double";
    if (existingType === "long long" || nextType === "long long") return "long long";
    return "int";
  }

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


function normalizeCppDeclarationType(rawType) {
  const normalized = String(rawType || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "int";

  return normalized
    .replace(/^const\s+/, "")
    .replace(/\s*&&\s*$/, "")
    .replace(/\s*&\s*$/, "")
    .trim();
}

function stripCppComments(source) {
  return String(source || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function buildWrappedCpp(code, functionName, args, argTypes) {
  const safeCode = code;
  const uncommentedCode = stripCppComments(code);
  const normalized = String(functionName || "").trim();
  const safeArgs = Array.isArray(args) ? args : [];
  const explicitArgTypes = Array.isArray(argTypes) ? argTypes : [];
  const usesListNode = explicitArgTypes.some((t) => /\bListNode\s*\*/.test(String(t || ""))) || /\bListNode\b/.test(uncommentedCode);
  const needsListNodeStruct = usesListNode && !/\b(struct|class)\s+ListNode\b/.test(uncommentedCode);
  const declaredArgs = safeArgs.map((arg, idx) => {
    const hinted = explicitArgTypes[idx];
    const normalizedHint = typeof hinted === "string" && hinted.trim()
      ? normalizeCppDeclarationType(hinted)
      : "";

    if (usesListNode && /\bListNode\s*\*/.test(normalizedHint) && Array.isArray(arg)) {
      return `ListNode* __arg${idx} = __make_list(vector<int>${serializeCppLiteral(arg)});`;
    }

    const type = normalizedHint || inferCppArgType(arg);
    return `${type} __arg${idx} = ${serializeCppLiteral(arg)};`;
  });
  const callSignatureArgs = safeArgs.map((_, idx) => `__arg${idx}`).join(", ");
  const isClassBased = /\bclass\s+Solution\s*:\s*public\b/.test(code) || /\bclass\s+Solution\s*{/.test(code) || /\bclass\s+Solution\b/.test(code);
  const callLambdaBody = isClassBased
    ? `Solution __solution; return __solution.${normalized}(${callSignatureArgs});`
    : `return ${normalized}(${callSignatureArgs});`;

  const listNodeHelpers = usesListNode ? [
    "",
    needsListNodeStruct ? "struct ListNode { int val; ListNode* next; ListNode(): val(0), next(nullptr) {} ListNode(int x): val(x), next(nullptr) {} ListNode(int x, ListNode* n): val(x), next(n) {} };" : "",
    "ListNode* __make_list(const vector<int>& values) {",
    "  ListNode dummy(0);",
    "  ListNode* cur = &dummy;",
    "  for (int v : values) {",
    "    cur->next = new ListNode(v);",
    "    cur = cur->next;",
    "  }",
    "  return dummy.next;",
    "}",
    "string __to_json(ListNode* node) {",
    "  if (node == nullptr) return \"[]\";",
    "  string out = \"[\";",
    "  bool first = true;",
    "  int guard = 0;",
    "  while (node != nullptr && guard < 10000) {",
    "    if (!first) out += \",\";",
    "    first = false;",
    "    out += to_string(node->val);",
    "    node = node->next;",
    "    guard += 1;",
    "  }",
    "  return out + \"]\";",
    "}",
  ] : [];

  return [
    "#include <bits/stdc++.h>",
    "using namespace std;",
    "",
    ...listNodeHelpers,
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
    "string __to_json(const vector<string>& value) {",
    "  string out = \"[\";",
    "  for (size_t i = 0; i < value.size(); i += 1) {",
    "    if (i) out += \",\";",
    "    out += value[i];",
    "  }",
    "  return out + \"]\";",
    "}",
    "",
    "int main() {",
    "  try {",
    "    " + declaredArgs.join("\n    "),
    "    " + (normalized ? `auto __call = [&](){ ${callLambdaBody} };` : ""),
    "    if constexpr (std::is_same_v<std::invoke_result_t<decltype(__call)>, void>) {",
    "      __call();",
    "      vector<string> __mut;",
    ...safeArgs.map((_, idx) => `      __mut.push_back(__to_json(__arg${idx}));`),
    "      string __mutated_json = __to_json(__mut);",
    "      std::cout << \"{\\\"__judge\\\":{\\\"result\\\":null,\\\"mutatedArgs\\\":\" << __mutated_json << \"}}\\n\";",
    "    } else {",
    "      auto __result = __call();",
    "      vector<string> __mut;",
    ...safeArgs.map((_, idx) => `      __mut.push_back(__to_json(__arg${idx}));`),
    "      string __mutated_json = __to_json(__mut);",
    "      std::cout << \"{\\\"__judge\\\":{\\\"result\\\":\" << __to_json(__result) << \",\\\"mutatedArgs\\\":\" << __mutated_json << \"}}\\n\";",
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
      const pythonPrelude = /from __future__ import annotations/.test(code)
        ? ""
        : "from __future__ import annotations\n";
      const pythonCode = /from typing import/.test(code)
        ? `${pythonPrelude}${code}`
        : `${pythonPrelude}from typing import *\n${code}`;
      await fs.writeFile(file, pythonCode, "utf8");
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

app.post("/debug-wrap", (req, res) => {
  if (!authorizeDebugWrap(req, res)) return;

  const { language, code, functionName, args, argTypes } = req.body || {};

  if (!language || !code) {
    return res.status(400).json({ error: "language and code are required" });
  }

  if (!["javascript", "python", "cpp"].includes(language)) {
    return res.status(400).json({ error: "Invalid language. Must be javascript, python, or cpp" });
  }

  if (typeof functionName !== "string" || !functionName.trim() || !Array.isArray(args)) {
    return res.status(400).json({
      error: "functionName and args[] are required for debug wrap",
    });
  }

  let wrappedCode = "";
  if (language === "javascript") {
    wrappedCode = buildWrappedJavascript(code, functionName, args, argTypes);
  } else if (language === "python") {
    wrappedCode = buildWrappedPython(code, functionName, args, argTypes);
  } else {
    wrappedCode = buildWrappedCpp(code, functionName, args, argTypes);
  }

  return res.status(200).json({
    ok: true,
    language,
    functionName,
    argCount: args.length,
    wrappedCode,
  });
});

app.post("/run", async (req, res) => {
  const { language, code, stdin = "", timeoutMs, functionName, args, argTypes } = req.body || {};
  const effectiveTimeoutMs = clampTimeout(timeoutMs);

  if (!language || !code) {
    return res.status(400).json({ error: "language and code are required" });
  }

  try {
    if (typeof functionName === "string" && functionName.trim() && Array.isArray(args)) {
      let runnableCode = "";

      if (language === "javascript") {
        runnableCode = buildWrappedJavascript(code, functionName, args, argTypes);
      } else if (language === "python") {
        runnableCode = buildWrappedPython(code, functionName, args, argTypes);
      } else if (language === "cpp") {
        runnableCode = buildWrappedCpp(code, functionName, args, argTypes);
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
  const { language, code, functionName, testCases = [], timeoutMs, argTypes } = req.body || {};
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
          ? buildWrappedCpp(code, functionName, test.args, Array.isArray(test.argTypes) ? test.argTypes : argTypes)
          : language === "python"
          ? buildWrappedPython(code, functionName, test.args, Array.isArray(test.argTypes) ? test.argTypes : argTypes)
          : buildWrappedJavascript(code, functionName, test.args, Array.isArray(test.argTypes) ? test.argTypes : argTypes);

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











