# beatcode-judge-service

This folder contains the independent Node.js judge service used by BeatCode to execute
user submissions for JavaScript, Python, and C++.

## Runtime endpoints

- `GET /health`  
  Returns `{ "ok": true }`.

- `POST /run`  
  Executes one submission (single run).  
  Supports two modes:
  1) **Function-based mode** (used by the app): provide `functionName` + `args`.
  2) **stdin/stdout mode**: provide `stdin` directly.

- `POST /judge`  
  Executes against an array of test cases and returns `{ passed, failedAt, reason, ... }`.
  If each test item includes `args`, function-based mode is used.

## Environment

- `PORT` (default `5050`)
- `DEFAULT_TIMEOUT_MS` (default `2000`)
- `MAX_TIMEOUT_MS` (default `5000`)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)
- `RATE_LIMIT_MAX_REQUESTS` (default `60`)

## Request format

### Function-based `/run` (recommended for LeetCode-style problems)

```json
{
  "language": "javascript" | "python" | "cpp",
  "code": "<user code>",
  "functionName": "twoSum",
  "args": [[2,7,11,15], 9],
  "timeoutMs": 5000
}
```

- `args` must be an array containing one entry per function argument.
- For each test, the server wraps the user code and prints JSON output for return value.
- On success, response is similar to:

```json
{
  "stdout": "4\n",
  "stderr": "",
  "exitCode": 0,
  "timeMs": 24,
  "phase": "run"
}
```

### Function-based `/judge` with test cases

```json
{
  "language": "cpp",
  "code": "class Solution { public: int twoSum(vector<int> nums, int target) { ... } };",
  "functionName": "twoSum",
  "testCases": [
    { "args": [[2,7,11,15], 9], "expectedOutput": "4" },
    { "args": [[3,3], 6], "expectedOutput": "0" }
  ],
  "timeoutMs": 5000
}
```

- If a test case includes `args`, `/judge` evaluates via the same harness as `/run`.
- If no `args` are present, it falls back to stdin/stdout mode and uses `input` / `expectedOutput`.

## C++ harness details

When `language === "cpp"` and `functionName` + `args` are present, the server:

1) infers lightweight C++ types from each argument value (best effort),
2) declares local variables with those values,
3) calls the target function by name,
4) prints JSON-like return value to stdout.

### Supported / expected shapes

- Scalars: `bool`, `int`/`long long`, `double`, `string`.
- 1D vectors: `vector<long long>`, `vector<double>`, `vector<string>`, `vector<bool>` (best effort).
- Nested vectors: `vector<vector<...>>` (best effort from sample data shape).
- Optional class-based signature (LeetCode style):

```cpp
class Solution {
public:
  int twoSum(vector<int> nums, int target) { ... }
};
```

invoked as `Solution solution; solution.twoSum(...);`

- If class structure is not detected, direct call is used: `twoSum(...)`.

### Important notes

- This is lightweight judge harnessing intended for prototype/sprint use.
- Non-trivial object payloads in C++ (maps/structs/custom classes) are best effort only.
- Return types are compared by frontend parser as JSON strings on `stdout`.
- `void` returns are printed as `null`.

## Local run

From this directory:

```bash
npm install
npm run start
```

The service should be reachable at `http://localhost:5050`.

## Quick curl checks

### Health

```bash
curl -X GET "http://localhost:5050/health"
```

### JS /run (function mode)

```bash
curl -X POST "http://localhost:5050/run" \
  -H "Content-Type: application/json" \
  -d '{
    "language": "javascript",
    "code": "function twoSum(nums, target) { let m = new Map(); for (let i = 0; i < nums.length; i++) { const r = target - nums[i]; if (m.has(r)) return [m.get(r), i]; m.set(nums[i], i); } return []; }",
    "functionName": "twoSum",
    "args": [[2,7,11,15], 9]
  }'
```

### Python /run (function mode)

```bash
curl -X POST "http://localhost:5050/run" \
  -H "Content-Type: application/json" \
  -d '{
    "language": "python",
    "code": "def twoSum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n    return []",
    "functionName": "twoSum",
    "args": [[2,7,11,15], 9]
  }'
```

### C++ /run (function mode, class Solution)

```bash
curl -X POST "http://localhost:5050/run" \
  -H "Content-Type: application/json" \
  -d '{
    "language": "cpp",
    "code": "#include <bits/stdc++.h>\nusing namespace std;\nclass Solution { public:\n    int twoSum(vector<int> nums, int target) {\n      unordered_map<int, int> idx;\n      for (int i = 0; i < (int)nums.size(); ++i) {\n        int need = target - nums[i];\n        if (idx.count(need)) return idx[need];\n        idx[nums[i]] = i;\n      }\n      return -1;\n    }\n};",
    "functionName": "twoSum",
    "args": [[2,7,11,15], 9]
  }'
```

### C++ /judge with args-based tests

```bash
curl -X POST "http://localhost:5050/judge" \
  -H "Content-Type: application/json" \
  -d '{
    "language": "cpp",
    "functionName": "twoSum",
    "code": "#include <bits/stdc++.h>\nusing namespace std;\nclass Solution { public:\n    int twoSum(vector<int> nums, int target) {\n      unordered_map<int, int> idx;\n      for (int i = 0; i < (int)nums.size(); ++i) {\n        int need = target - nums[i];\n        if (idx.count(need)) return idx[need];\n        idx[nums[i]] = i;\n      }\n      return -1;\n    }\n};",
    "testCases": [
      { "args": [[2,7,11,15], 9], "expectedOutput": "1" },
      { "args": [[3,3], 6], "expectedOutput": "0" },
      { "args": [[-1,0,1], 0], "expectedOutput": "1" }
    ],
    "timeoutMs": 5000
  }'
```
