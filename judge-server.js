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
  const recursionFixed = noSelf.replace(
    new RegExp(`\\b(?:self|cls)\\.${functionName}\\s*\\(`, "g"),
    `${functionName}(`
  );

  return recursionFixed.trim();
}

function shouldUseLinkedListHarness(code, functionName, argTypes) {
  const fn = String(functionName || "");
  const source = String(code || "");
  const hintedTypes = Array.isArray(argTypes) ? argTypes.join(" ") : "";
  return /\bListNode\b/.test(source) || /\bListNode\b/.test(hintedTypes) || fn === "addTwoNumbers";
}

function stripPythonLineComments(source) {
  return String(source || "").replace(/^[ \t]*#.*$/gm, "");
}

function shouldUseTreeHarness(code, functionName, argTypes) {
  const fn = String(functionName || "");
  const source = String(code || "");
  const hintedTypes = Array.isArray(argTypes) ? argTypes.join(" ") : "";
  const knownTreeFns = new Set([
    "inorderTraversal",
    "preorderTraversal",
    "postorderTraversal",
    "maxDepth",
    "isSameTree",
    "isSymmetric",
    "levelOrder",
  ]);
  return /\bTreeNode\b/.test(source) || /\bTreeNode\b/.test(hintedTypes) || knownTreeFns.has(fn);
}

function stripJavascriptComments(source) {
  return String(source || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function buildWrappedPython(code, functionName, args, argTypes) {
  const argsJsonLiteral = JSON.stringify(JSON.stringify(args || []));
  const fnLower = String(functionName || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const disableTreeArgAdaptation = fnLower.includes("sortedarraytobst");
  const isHasCycle = fnLower === "hascycle";
  const isGetIntersectionNode = fnLower === "getintersectionnode";
  const safeCode = code.includes("from typing import")
    ? preprocessPythonCodeForJudge(code, functionName)
    : `from typing import *\n${preprocessPythonCodeForJudge(code, functionName)}`;
  const useLinkedList = shouldUseLinkedListHarness(code, functionName, argTypes);
  const useTree = !useLinkedList && shouldUseTreeHarness(code, functionName, argTypes);

  if (!useLinkedList && !useTree) {
    return `${safeCode}\n\nimport json as _json\n_args = _json.loads(${argsJsonLiteral})\n_result = ${functionName}(*_args)\nprint(_json.dumps({"__judge":{"result":_result,"mutatedArgs":_args}}))\n`;
  }

  if (useLinkedList) {
    const uncommentedPy = stripPythonLineComments(safeCode);
    const listNodePrelude = /\bclass\s+ListNode\b/.test(uncommentedPy)
      ? ""
      : `class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val = val\n        self.next = next\n\n`;

    return `${listNodePrelude}${safeCode}\n\nimport json as _json\n\ndef __build_list(values):\n    dummy = ListNode(0)\n    cur = dummy\n    for v in values:\n        cur.next = ListNode(v)\n        cur = cur.next\n    return dummy.next\n\ndef __build_list_with_nodes(values):\n    dummy = ListNode(0)\n    cur = dummy\n    nodes = []\n    for v in values:\n        cur.next = ListNode(v)\n        cur = cur.next\n        nodes.append(cur)\n    return dummy.next, nodes\n\ndef __make_cycle(head, pos):\n    if head is None or pos is None or pos < 0:\n        return head\n    idx = 0\n    cur = head\n    target = None\n    tail = None\n    seen = 0\n    while cur is not None and seen < 100000:\n        if idx == pos:\n            target = cur\n        tail = cur\n        cur = cur.next\n        idx += 1\n        seen += 1\n    if tail is not None and target is not None:\n        tail.next = target\n    return head\n\ndef __make_intersection(intersect_val, list_a, list_b, skip_a, skip_b):\n    head_a, nodes_a = __build_list_with_nodes(list_a)\n    should_intersect = bool(intersect_val) and 0 <= skip_a < len(nodes_a)\n    if not should_intersect:\n        return head_a, __build_list(list_b)\n    shared = nodes_a[skip_a]\n    head_b = __build_list(list_b[:max(0, skip_b)])\n    if head_b is None:\n        head_b = shared\n    else:\n        tail = head_b\n        guard = 0\n        while tail.next is not None and guard < 100000:\n            tail = tail.next\n            guard += 1\n        tail.next = shared\n    return head_a, head_b\n\ndef __list_to_array(node):\n    out = []\n    seen = 0\n    while node is not None and seen < 10000:\n        out.append(node.val)\n        node = node.next\n        seen += 1\n    return out\n\ndef __normalize_value(v):\n    if v is None:\n        return []\n    if hasattr(v, "val") and hasattr(v, "next"):\n        return __list_to_array(v)\n    return v\n\n_args = _json.loads(${argsJsonLiteral})\nif ${isHasCycle ? "True" : "False"}:\n    _raw_head = _args[0] if len(_args) > 0 and isinstance(_args[0], list) else []\n    _pos = _args[1] if len(_args) > 1 else -1\n    _head = __build_list(_raw_head)\n    _head = __make_cycle(_head, int(_pos) if isinstance(_pos, (int, float, str)) and str(_pos).lstrip('-').isdigit() else -1)\n    _adapted = [_head]\nelif ${isGetIntersectionNode ? "True" : "False"}:\n    _intersect = int(_args[0]) if len(_args) > 0 and str(_args[0]).lstrip('-').isdigit() else 0\n    _list_a = _args[1] if len(_args) > 1 and isinstance(_args[1], list) else []\n    _list_b = _args[2] if len(_args) > 2 and isinstance(_args[2], list) else []\n    _skip_a = int(_args[3]) if len(_args) > 3 and str(_args[3]).lstrip('-').isdigit() else -1\n    _skip_b = int(_args[4]) if len(_args) > 4 and str(_args[4]).lstrip('-').isdigit() else -1\n    _head_a, _head_b = __make_intersection(_intersect, _list_a, _list_b, _skip_a, _skip_b)\n    _adapted = [_head_a, _head_b]\nelse:\n    _adapted = [__build_list(a) if isinstance(a, list) else a for a in _args]\n_result = ${functionName}(*_adapted)\n_norm_result = __normalize_value(_result)\n_norm_args = _args if ${isHasCycle ? "True" : "False"} or ${isGetIntersectionNode ? "True" : "False"} else [__normalize_value(a) for a in _adapted]\nprint(_json.dumps({"__judge":{"result":_norm_result,"mutatedArgs":_norm_args}}))\n`;
  }

  const treeNodePrelude = /\bclass\s+TreeNode\b/.test(safeCode)
    ? ""
    : `class TreeNode:\n    def __init__(self, val=0, left=None, right=None):\n        self.val = val\n        self.left = left\n        self.right = right\n\n`;

  return `${treeNodePrelude}${safeCode}\n\nimport json as _json\nfrom collections import deque\n\ndef __looks_like_tree_array(v):\n    if not isinstance(v, list):\n        return False\n    if len(v) == 0:\n        return True\n    for x in v:\n        if isinstance(x, (list, dict)):\n            return False\n    return True\n\ndef __build_tree(values):\n    if not isinstance(values, list) or len(values) == 0:\n        return None\n    if values[0] is None:\n        return None\n    nodes = [None if v is None else TreeNode(v) for v in values]\n    kids = nodes[::-1]\n    root = kids.pop()\n    for node in nodes:\n        if node is not None:\n            if kids:\n                node.left = kids.pop()\n            if kids:\n                node.right = kids.pop()\n    return root\n\ndef __tree_to_array(root):\n    if root is None:\n        return []\n    out = []\n    q = deque([root])\n    seen = 0\n    while q and seen < 20000:\n        node = q.popleft()\n        if node is None:\n            out.append(None)\n        else:\n            out.append(node.val)\n            q.append(node.left)\n            q.append(node.right)\n        seen += 1\n    while out and out[-1] is None:\n        out.pop()\n    return out\n\ndef __normalize_value(v):\n    if v is None:\n        return []\n    if hasattr(v, 'val') and hasattr(v, 'left') and hasattr(v, 'right'):\n        return __tree_to_array(v)\n    return v\n\n_args = _json.loads(${argsJsonLiteral})\n_adapted = _args if ${disableTreeArgAdaptation ? "True" : "False"} else [__build_tree(a) if __looks_like_tree_array(a) else a for a in _args]\n_result = ${functionName}(*_adapted)\n_norm_result = __normalize_value(_result)\n_norm_args = [__normalize_value(a) for a in _adapted]\nprint(_json.dumps({"__judge":{"result":_norm_result,"mutatedArgs":_norm_args}}))\n`;
}

function buildWrappedJavascript(code, functionName, args, argTypes) {
  const fnLower = String(functionName || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const disableTreeArgAdaptation = fnLower.includes("sortedarraytobst");
  const isHasCycle = fnLower === "hascycle";
  const isGetIntersectionNode = fnLower === "getintersectionnode";
  const uncommentedJs = stripJavascriptComments(code);
  const useLinkedList = shouldUseLinkedListHarness(code, functionName, argTypes);
  const useTree = !useLinkedList && shouldUseTreeHarness(code, functionName, argTypes);

  if (!useLinkedList && !useTree) {
    return `${code}\n\n(async () => {\n  try {\n    const _args = JSON.parse(JSON.stringify(${JSON.stringify(args || [])}));\n    const _result = await Promise.resolve(${functionName}(..._args));\n    process.stdout.write(JSON.stringify({ __judge: { result: _result, mutatedArgs: _args } }) + "\\n");\n  } catch (err) {\n    process.stderr.write(String(err) + "\\n");\n    process.exit(1);\n  }\n})();\n`;
  }

  if (useLinkedList) {
    const listNodePrelude = /\b(class|function)\s+ListNode\b/.test(uncommentedJs)
      ? ""
      : `function ListNode(val, next) {\n  if (!(this instanceof ListNode)) return new ListNode(val, next);\n  this.val = (val === undefined ? 0 : val);\n  this.next = (next === undefined ? null : next);\n}\n\n`;

    return `${listNodePrelude}${code}\n\nfunction __buildList(values) {\n  const dummy = new ListNode(0);\n  let cur = dummy;\n  for (const v of values) {\n    cur.next = new ListNode(v);\n    cur = cur.next;\n  }\n  return dummy.next;\n}\n\nfunction __buildListWithNodes(values) {\n  const dummy = new ListNode(0);\n  let cur = dummy;\n  const nodes = [];\n  for (const v of values) {\n    cur.next = new ListNode(v);\n    cur = cur.next;\n    nodes.push(cur);\n  }\n  return { head: dummy.next, nodes };\n}\n\nfunction __makeCycle(head, pos) {\n  if (!head || !Number.isInteger(pos) || pos < 0) return head;\n  let idx = 0;\n  let cur = head;\n  let target = null;\n  let tail = null;\n  let seen = 0;\n  while (cur && seen < 100000) {\n    if (idx === pos) target = cur;\n    tail = cur;\n    cur = cur.next;\n    idx += 1;\n    seen += 1;\n  }\n  if (tail && target) tail.next = target;\n  return head;\n}\n\nfunction __makeIntersection(intersectVal, listA, listB, skipA, skipB) {\n  const builtA = __buildListWithNodes(Array.isArray(listA) ? listA : []);\n  const shouldIntersect = Number(intersectVal) !== 0 && Number.isInteger(skipA) && skipA >= 0 && skipA < builtA.nodes.length;\n  if (!shouldIntersect) {\n    return { headA: builtA.head, headB: __buildList(Array.isArray(listB) ? listB : []) };\n  }\n  const shared = builtA.nodes[skipA];\n  const prefixB = (Array.isArray(listB) ? listB : []).slice(0, Math.max(0, skipB));\n  let headB = __buildList(prefixB);\n  if (!headB) {\n    headB = shared;\n  } else {\n    let tail = headB;\n    let guard = 0;\n    while (tail.next && guard < 100000) {\n      tail = tail.next;\n      guard += 1;\n    }\n    tail.next = shared;\n  }\n  return { headA: builtA.head, headB };\n}\n\nfunction __listToArray(node) {\n  const out = [];\n  let seen = 0;\n  while (node && seen < 10000) {\n    out.push(node.val);\n    node = node.next;\n    seen += 1;\n  }\n  return out;\n}\n\nfunction __normalizeValue(v) {\n  if (v == null) return [];\n  if (v && typeof v === \"object\" && \"val\" in v && \"next\" in v) return __listToArray(v);\n  return v;\n}\n\n(async () => {\n  try {\n    const _rawArgs = ${JSON.stringify(args || [])};\n    let _args;\n    if (${isHasCycle ? "true" : "false"}) {\n      const _headRaw = Array.isArray(_rawArgs[0]) ? _rawArgs[0] : [];\n      const _pos = Number.isFinite(Number(_rawArgs[1])) ? Number(_rawArgs[1]) : -1;\n      const _head = __makeCycle(__buildList(_headRaw), _pos);\n      _args = [_head];\n    } else if (${isGetIntersectionNode ? "true" : "false"}) {\n      const _intersect = Number.isFinite(Number(_rawArgs[0])) ? Number(_rawArgs[0]) : 0;\n      const _listA = Array.isArray(_rawArgs[1]) ? _rawArgs[1] : [];\n      const _listB = Array.isArray(_rawArgs[2]) ? _rawArgs[2] : [];\n      const _skipA = Number.isFinite(Number(_rawArgs[3])) ? Number(_rawArgs[3]) : -1;\n      const _skipB = Number.isFinite(Number(_rawArgs[4])) ? Number(_rawArgs[4]) : -1;\n      const _heads = __makeIntersection(_intersect, _listA, _listB, _skipA, _skipB);\n      _args = [_heads.headA, _heads.headB];\n    } else {\n      _args = _rawArgs.map((a) => Array.isArray(a) ? __buildList(a) : a);\n    }\n    const _result = await Promise.resolve(${functionName}(..._args));\n    const _final = __normalizeValue(_result);\n    const _mutatedArgs = ${isHasCycle || isGetIntersectionNode ? "JSON.parse(JSON.stringify(_rawArgs))" : "_args.map((a) => __normalizeValue(a))"};\n    process.stdout.write(JSON.stringify({ __judge: { result: _final, mutatedArgs: _mutatedArgs } }) + \"\\n\");\n  } catch (err) {\n    process.stderr.write(String(err) + \"\\n\");\n    process.exit(1);\n  }\n})();\n`;
  }

  const treeNodePrelude = /\b(function|class)\s+TreeNode\b/.test(uncommentedJs)
    ? ""
    : `function TreeNode(val, left, right) {\n  this.val = (val === undefined ? 0 : val);\n  this.left = (left === undefined ? null : left);\n  this.right = (right === undefined ? null : right);\n}\n\n`;

  return `${treeNodePrelude}${code}\n\nfunction __looksLikeTreeArray(v) {\n  if (!Array.isArray(v)) return false;\n  if (v.length === 0) return true;\n  return v.every((x) => !Array.isArray(x) && (x === null || typeof x !== 'object'));\n}\n\nfunction __buildTree(values) {\n  if (!Array.isArray(values) || values.length === 0 || values[0] == null) return null;\n  const nodes = values.map((v) => (v == null ? null : new TreeNode(v)));\n  let i = 1;\n  for (let j = 0; j < nodes.length && i < nodes.length; j += 1) {\n    if (nodes[j] != null) {\n      nodes[j].left = i < nodes.length ? nodes[i++] : null;\n      nodes[j].right = i < nodes.length ? nodes[i++] : null;\n    }\n  }\n  return nodes[0];\n}\n\nfunction __treeToArray(root) {\n  if (!root) return [];\n  const out = [];\n  const q = [root];\n  let head = 0;\n  let seen = 0;\n  while (head < q.length && seen < 20000) {\n    const node = q[head++];\n    if (node == null) {\n      out.push(null);\n    } else {\n      out.push(node.val);\n      q.push(node.left ?? null);\n      q.push(node.right ?? null);\n    }\n    seen += 1;\n  }\n  while (out.length > 0 && out[out.length - 1] == null) out.pop();\n  return out;\n}\n\nfunction __normalizeValue(v) {\n  if (v == null) return [];\n  if (v && typeof v === \"object\" && \"val\" in v && \"left\" in v && \"right\" in v) return __treeToArray(v);\n  return v;\n}\n\n(async () => {\n  try {\n    const _rawArgs = ${JSON.stringify(args || [])};\n    const _args = ${disableTreeArgAdaptation ? "_rawArgs" : "_rawArgs.map((a) => __looksLikeTreeArray(a) ? __buildTree(a) : a)"};\n    const _result = await Promise.resolve(${functionName}(..._args));\n    const _final = __normalizeValue(_result);\n    const _mutatedArgs = _args.map((a) => __normalizeValue(a));\n    process.stdout.write(JSON.stringify({ __judge: { result: _final, mutatedArgs: _mutatedArgs } }) + \"\\n\");\n  } catch (err) {\n    process.stderr.write(String(err) + \"\\n\");\n    process.exit(1);\n  }\n})();\n`;
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

function serializeCppTreeTokens(values) {
  const list = Array.isArray(values) ? values : [];
  const rendered = list
    .map((v) => {
      if (v === null || v === undefined) return "\"null\"";
      return JSON.stringify(String(v));
    })
    .join(", ");
  return `{${rendered}}`;
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
  const normalizedLower = normalized.toLowerCase();
  const isHasCycle = normalizedLower === "hascycle";
  const safeArgs = Array.isArray(args) ? args : [];
  const explicitArgTypes = Array.isArray(argTypes) ? argTypes : [];
  const usesListNode = explicitArgTypes.some((t) => /\bListNode\s*\*/.test(String(t || ""))) || /\bListNode\b/.test(uncommentedCode);
  const usesTreeNode = !usesListNode && (
    explicitArgTypes.some((t) => /\bTreeNode\s*\*/.test(String(t || ""))) || /\bTreeNode\b/.test(uncommentedCode)
  );
  const needsListNodeStruct = usesListNode && !/\b(struct|class)\s+ListNode\b/.test(uncommentedCode);
  const needsTreeNodeStruct = usesTreeNode && !/\b(struct|class)\s+TreeNode\b/.test(uncommentedCode);
  const declaredArgs = safeArgs.map((arg, idx) => {
    const hinted = explicitArgTypes[idx];
    const normalizedHint = typeof hinted === "string" && hinted.trim()
      ? normalizeCppDeclarationType(hinted)
      : "";

    if (usesListNode && /\bListNode\s*\*/.test(normalizedHint) && Array.isArray(arg)) {
      return `ListNode* __arg${idx} = __make_list(vector<int>${serializeCppLiteral(arg)});`;
    }
    if (usesTreeNode && /\bTreeNode\s*\*/.test(normalizedHint) && Array.isArray(arg)) {
      return `TreeNode* __arg${idx} = __make_tree(vector<string>${serializeCppTreeTokens(arg)});`;
    }

    const type = normalizedHint || inferCppArgType(arg);
    return `${type} __arg${idx} = ${serializeCppLiteral(arg)};`;
  });
  const callSignatureArgs = isHasCycle ? "__arg0" : safeArgs.map((_, idx) => `__arg${idx}`).join(", ");
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
    "void __make_cycle(ListNode* head, int pos) {",
    "  if (head == nullptr || pos < 0) return;",
    "  int idx = 0;",
    "  ListNode* cur = head;",
    "  ListNode* target = nullptr;",
    "  ListNode* tail = nullptr;",
    "  int guard = 0;",
    "  while (cur != nullptr && guard < 100000) {",
    "    if (idx == pos) target = cur;",
    "    tail = cur;",
    "    cur = cur->next;",
    "    idx += 1;",
    "    guard += 1;",
    "  }",
    "  if (tail != nullptr && target != nullptr) tail->next = target;",
    "}",
  ] : [];

  const treeNodeHelpers = usesTreeNode ? [
    "",
    needsTreeNodeStruct ? "struct TreeNode { int val; TreeNode* left; TreeNode* right; TreeNode(): val(0), left(nullptr), right(nullptr) {} TreeNode(int x): val(x), left(nullptr), right(nullptr) {} TreeNode(int x, TreeNode* l, TreeNode* r): val(x), left(l), right(r) {} };" : "",
    "TreeNode* __make_tree(const vector<string>& values) {",
    "  if (values.empty()) return nullptr;",
    "  if (values[0] == \"null\") return nullptr;",
    "  TreeNode* root = new TreeNode(stoi(values[0]));",
    "  queue<TreeNode*> q;",
    "  q.push(root);",
    "  size_t i = 1;",
    "  while (!q.empty() && i < values.size()) {",
    "    TreeNode* node = q.front(); q.pop();",
    "    if (i < values.size() && values[i] != \"null\") {",
    "      node->left = new TreeNode(stoi(values[i]));",
    "      q.push(node->left);",
    "    }",
    "    i += 1;",
    "    if (i < values.size() && values[i] != \"null\") {",
    "      node->right = new TreeNode(stoi(values[i]));",
    "      q.push(node->right);",
    "    }",
    "    i += 1;",
    "  }",
    "  return root;",
    "}",
    "string __to_json(TreeNode* root) {",
    "  if (root == nullptr) return \"[]\";",
    "  vector<string> out;",
    "  queue<TreeNode*> q;",
    "  q.push(root);",
    "  int seen = 0;",
    "  while (!q.empty() && seen < 20000) {",
    "    TreeNode* node = q.front(); q.pop();",
    "    if (node == nullptr) {",
    "      out.push_back(\"null\");",
    "    } else {",
    "      out.push_back(to_string(node->val));",
    "      q.push(node->left);",
    "      q.push(node->right);",
    "    }",
    "    seen += 1;",
    "  }",
    "  while (!out.empty() && out.back() == \"null\") out.pop_back();",
    "  string s = \"[\";",
    "  for (size_t i = 0; i < out.size(); i += 1) {",
    "    if (i) s += \",\";",
    "    s += out[i];",
    "  }",
    "  return s + \"]\";",
    "}",
  ] : [];

  return [
    "#include <bits/stdc++.h>",
    "using namespace std;",
    "",
    ...listNodeHelpers,
    ...treeNodeHelpers,
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
    "template <typename F>",
    "string __run_and_result_json(F&& fn) {",
    "  if constexpr (std::is_void_v<std::invoke_result_t<F>>) {",
    "    fn();",
    "    return \"null\";",
    "  } else {",
    "    auto __result = fn();",
    "    return __to_json(__result);",
    "  }",
    "}",
    "",
    "int main() {",
    "  try {",
    "    " + declaredArgs.join("\n    "),
    "    " + (isHasCycle ? "__make_cycle(__arg0, (int)__arg1);" : ""),
    "    " + (normalized ? `auto __call = [&](){ ${callLambdaBody} };` : ""),
    "    string __result_json = __run_and_result_json(__call);",
    "    vector<string> __mut;",
    ...safeArgs.map((_, idx) => `    __mut.push_back(__to_json(__arg${idx}));`),
    "    string __mutated_json = __to_json(__mut);",
    "    std::cout << \"{\\\"__judge\\\":{\\\"result\\\":\" << __result_json << \",\\\"mutatedArgs\\\":\" << __mutated_json << \"}}\\n\";",
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











