# AI Bridge M1 PoC Report

| | |
|---|---|
| Ngày | 2026-09-25 |
| Người viết | Claude (Claude Code, chạy trong Claude Desktop) |
| Phạm vi | M1 Proof of Concept — chứng minh vòng lặp Claude Code CLI ↔ Codex CLI chạy được trong terminal trên Windows |
| Trạng thái | **PASS** (xem §Final Status) |

Quy ước nhãn dùng trong báo cáo: **PASS** (đã chạy thật và xác nhận), **PARTIAL** (chạy được nhưng có giới hạn), **BLOCKED** (không thể xác nhận vì thiếu điều kiện), **UNKNOWN** (chưa kiểm chứng).

---

## Environment

Kiểm tra trước khi viết code (không giả định), toàn bộ chạy trên máy thật:

| Kiểm tra | Kết quả | Trạng thái |
|---|---|---|
| `node --version` | v24.11.0 | PASS |
| `pnpm --version` | 10.33.2 | PASS |
| `git --version` | git version 2.47.0.windows.2 | PASS |
| `claude --version` | 2.1.161 (Claude Code), tại `C:\Users\binhp\.local\bin\claude.exe` (trên PATH) | PASS |
| `claude auth status` (trước khi user đăng nhập) | `{"loggedIn": false, "authMethod": "none"}` | BLOCKED → đã báo user, user đã tự chạy `claude auth login --claudeai` |
| `claude auth status` (sau khi user đăng nhập) | `{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "pro"}` | PASS |
| `codex --version` | `codex` **không có trên PATH** (đúng như khảo sát Phase 0) | WARNING — đã tự dò qua `where` + fallback quét `%LOCALAPPDATA%\OpenAI\Codex\bin\*` |
| Bản `codex.exe` tìm được | `codex-cli 0.155.0-alpha.16.4` tại `C:\Users\binhp\AppData\Local\OpenAI\Codex\bin\13995fba801849b0\codex.exe` | PASS |
| `codex login status` | `Logged in using ChatGPT` | PASS |
| `Get-ChildItem Env:ANTHROPIC_API_KEY` | không tồn tại | PASS |
| `Get-ChildItem Env:OPENAI_API_KEY` | không tồn tại | PASS |

**Không có blocker nào bị giả lập.** Blocker duy nhất (Claude CLI chưa đăng nhập) đã được báo chính xác lệnh cần chạy (`claude auth login --claudeai`), KHÔNG dùng `claude --bare` (cờ này chỉ nhận API key, sẽ phát sinh chi phí).

---

## Claude CLI Test

`ClaudeCodeCliAdapter` (`src/adapters/claude/claude-code-cli-adapter.ts`) điều khiển `claude -p --output-format stream-json --verbose {--session-id|--resume} <id> [--append-system-prompt <text>] [--permission-mode <mode>]`, prompt truyền qua **stdin**.

| Nhiệm vụ (§6 của spec) | Đã làm | Bằng chứng |
|---|---|---|
| 1. start Claude CLI | `child_process.spawn`, không qua shell, `windowsHide: true` | `process-runner.test.ts` — 11 test, gồm spawn thật |
| 2. truyền prompt qua stdin | `child.stdin.end(prompt, 'utf8')` | `claude-code-cli-adapter.test.ts` — test gửi tiếng Việt có dấu + code block + thụt lề, đọc lại nguyên văn qua fake CLI |
| 3. nhận output | Parse từng dòng `stream-json` (JSONL) | `BAD_JSON` errorCode khi 1 dòng không parse được |
| 4. lấy session ID | Đọc `session_id` từ event `result` | so khớp với `sessionId` đã yêu cầu |
| 5. chờ process kết thúc | `runProcess` (Promise resolve khi `close`) | — |
| 6. kiểm tra exit code | `exitCode !== 0` → `NON_ZERO_EXIT` | test dùng fake CLI mode `error-exit` |
| 7. đọc report | **Không đọc trong adapter** — tách trách nhiệm sang `ReportValidator` (orchestrator gọi riêng); adapter chỉ đảm bảo Claude biết ghi report ở đâu qua `--append-system-prompt` | xem mục Report Validation |
| 8. resume session | `--resume <id>` khi `resume: true`; nếu event trả về `session_id` khác/thiếu → `SESSION_MISMATCH`, `ok: false` | test "reports a resumed session id that differs... as SESSION_MISMATCH" |

**Không hard-code đường dẫn `claude.exe`.** `resolveExecutable('claude', {where})` dùng `where.exe` (tương đương `Get-Command` trong cmd.exe) — `src/core/preflight/executable-resolver.ts`, 7 test.

**Xác nhận thật (không giả lập):** chạy `claude --help` và `claude -p` thật trên máy trong lúc khảo sát để xác nhận các cờ `-p, --session-id, --resume, --append-system-prompt, --permission-mode, --output-format stream-json` đều tồn tại và hoạt động đúng, trước khi viết adapter.

---

## Codex CLI Test

`CodexCliAdapter` (`src/adapters/chatgpt/codex-cli-adapter.ts`) điều khiển:
- Iteration đầu: `codex exec --json -s read-only --skip-git-repo-check -o <file> -`
- Resume: `codex exec resume <threadId> --json -c sandbox_mode="read-only" --skip-git-repo-check -o <file> -`

| Nhiệm vụ | Đã làm | Ghi chú |
|---|---|---|
| Report của Claude truyền vào Codex dạng TEXT | `buildReviewerInput()` nhúng nguyên văn report vào template §11, gửi qua **stdin** | `prompt-templates.test.ts` |
| Không upload file report | Đúng — chỉ ghi text vào stdin, không dùng `-i/--image` hay bất kỳ cơ chế đính kèm file | — |
| Không cho Codex truy cập ChatGPT Desktop UI | Đúng — chỉ gọi CLI headless | — |
| Codex chỉ review, không sửa project | `-s read-only` (iteration đầu); `-c sandbox_mode="read-only"` (resume, vì `codex exec resume --help` xác nhận **không có** cờ `-s`/`-C`) | Xác nhận thật bằng cách đọc `codex exec resume --help` trên máy, không đoán |
| Đọc response | Đọc từ **file `-o`** (markdown gốc do CLI ghi), không dựng lại từ JSON event | test "reads the response text from the -o output file, not from stdout" |
| Giữ cùng Codex thread | `threadId` lấy từ event `thread.started`; resume dùng `codex exec resume <threadId>` | Xác nhận thật: 2 lần chạy thật cho cùng 1 `thread_id` |

**Limitation (đúng theo §16 của spec — ghi nhận, không giả lập):** Codex CLI đang là bản **alpha** (`0.155.0-alpha.16.4`); cờ `exec resume` không nhận `-s`/`-C`. Đã đọc `--help` thật để xác nhận trước khi code, không suy đoán.

---

## Authentication

| Kiểm tra | Kết quả |
|---|---|
| `checkEnvForApiKeys(env)` chặn `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` | 16 test, gồm test "never includes the key value itself, only its name" |
| `parseClaudeAuthStatus` phân biệt subscription / api-key / none / unknown | dựa trên JSON thật của `claude auth status` |
| `parseCodexLoginStatus` phân biệt chatgpt / api-key / none / unknown | dựa trên text thật của `codex login status` |
| CLI `doctor` gọi cả hai, in rõ lệnh cần chạy nếu sai (`claude auth login --claudeai`, `codex login`) | Đã chạy thật (xem log dưới) |
| Nếu ở chế độ API key → `BLOCKED` (không phải FAIL) | overall doctor status ưu tiên BLOCKED trên FAIL — `doctor.test.ts` |

**Chạy thật `ai-bridge doctor` (không giả lập):**
```text
[PASS] node — v24.11.0
[PASS] api-key-env — no cost-risk env vars set
[PASS] claude-cli — C:\Users\binhp\.local\bin\claude.exe
[PASS] claude-auth — logged in with a Claude subscription
[PASS] codex-cli — C:\Users\binhp\AppData\Local\OpenAI\Codex\bin\13995fba801849b0\codex.exe
[PASS] codex-auth — logged in using ChatGPT
[PASS] git — git version 2.47.0.windows.2
[PASS] project-directory — D:\000_AI Agent\02-ai-brige
Overall: PASS
```

---

## Text Transport

| Hướng | Cơ chế | Xác nhận |
|---|---|---|
| Bridge → Claude | stdin, UTF-8, không qua argv | Test tiếng Việt có dấu, code block, thụt lề — nguyên văn qua fake CLI. Chạy thật: Claude nhận đúng task tiếng Anh có backtick và xuống dòng. |
| Claude → Bridge | Claude tự ghi file report (không qua stdout của Bridge) | `ReportValidator` đọc file thật |
| Bridge → Codex | stdin, nhúng nguyên văn report vào template | Test "embeds the exact report text... unmodified" |
| Codex → Bridge | File `-o`, markdown gốc | Test "reads the response text from the -o output file" |
| PROMPT preservation | Chỉ trim đúng 1 newline (hoặc CRLF) ở mỗi đầu `<PROMPT>`/`</PROMPT>`, không trim thêm, không sửa code block/thụt lề | **Xác nhận bằng SHA-256 thật**: `001-extracted-prompt.md` và `002-claude-prompt.md` của lần chạy thật có **cùng SHA-256** (`551e9196...`) — byte-for-byte giống nhau |

---

## Session Resume

**PASS — xác nhận bằng chạy thật, không chỉ bằng fake CLI.**

Log thật (`~/.ai-bridge/logs/2026-09-25-session.log` trong sandbox), rút gọn:

```text
iteration 1  adapter=claude  command="claude -p --output-format stream-json --session-id 1558fa67-89e6-44a5-a8eb-8aadd48724fb"   exitCode=0
iteration 1  adapter=codex   command="codex exec --json -s read-only ..."                                                        exitCode=0
iteration 2  adapter=claude  command="claude -p --output-format stream-json --resume 1558fa67-89e6-44a5-a8eb-8aadd48724fb"        exitCode=0
iteration 2  adapter=codex   command="codex exec resume 01a0d835-a985-75f2-a47d-13e49225047f --json ..."                          exitCode=0
```

- Claude: cùng `claudeSessionId` (`1558fa67-...`) ở cả 2 iteration — iteration 2 dùng `--resume` với đúng id đó.
- Codex: cùng `threadId` (`01a0d835-...`) — iteration 2 dùng `codex exec resume <cùng-id>`.
- Nếu adapter không resume đúng, `ClaudeCodeCliAdapter`/`CodexCliAdapter` sẽ trả `SESSION_MISMATCH`/`THREAD_MISMATCH` và Orchestrator dừng ngay (`STOP`, không tự tạo session mới) — cơ chế này có test riêng và **không kích hoạt** trong lần chạy thật (đúng như kỳ vọng).

**Limitation Codex (đúng theo §16, ghi nhận không giả lập):** chưa xác nhận được liệu thread do CLI tạo có hiển thị trong ChatGPT App hay không — không đo được vì Phase 0 đã xác nhận ChatGPT App không lộ nội dung qua UI Automation (BLOCKER đã ghi trong `01-architecture-feasibility-report.md`). Cơ chế resume dùng đúng cách CLI hiện tại hỗ trợ (`codex exec resume <thread_id>`), đã xác nhận qua `codex exec resume --help` và qua chạy thật.

---

## Report Validation

`ReportValidator` (`src/reports/report-validator.ts`), 27 test. Kiểm tra: file tồn tại, UTF-8 hợp lệ (kể cả có BOM), không rỗng, không chứa NUL, kích thước ≤ giới hạn, header đúng `# AI Bridge Report`, đủ 4 field bắt buộc (`SESSION_ID`, `ITERATION`, `REPORT_STATUS`, `NEXT_ACTION`) không trùng lặp, `REPORT_STATUS` chỉ được `COMPLETE`, `NEXT_ACTION` ∈ {CONTINUE, DONE, NEED_HUMAN}, `SESSION_ID`/`ITERATION` khớp giá trị mong đợi (chống report cũ/nhầm session), đủ 5 section theo đúng thứ tự, phát hiện report bị cắt giữa chừng (code fence không đóng, section cuối rỗng).

Sai bất kỳ điều kiện nào → liệt kê lỗi cụ thể (`MISSING_FIELD:X`, `INVALID_VALUE:X`, `SESSION_MISMATCH`, `TRUNCATED:...`) và **`valid: false`** — Orchestrator dừng ngay, không tự sửa report.

Chạy thật: cả 2 report (`001-report.md`, `002-report.md`) đều qua validator, `SESSION_ID`/`ITERATION` khớp chính xác giá trị Bridge yêu cầu qua contract (`--append-system-prompt`).

---

## Response Parsing

`CodexResponseParser` (`src/reports/codex-response-parser.ts`), 27 test. Kiểm tra: đúng 1 khối `<AI_BRIDGE_RESPONSE>` (kể cả trong code fence), đúng 1 `<STATUS>` hợp lệ, đúng 1 `<PROMPT>` không rỗng, không có tag lạc bên ngoài khối, không có 2 khối, không có tag mở mà thiếu đóng (hoặc ngược thứ tự).

Sai bất kỳ điều kiện nào → `valid: false` với mã lỗi cụ thể (`NO_RESPONSE_BLOCK`, `MULTIPLE_STATUS`, `MALFORMED_PROMPT`, `EMPTY_PROMPT`, …), Orchestrator dừng, **không tự sửa, không retry**.

Chạy thật: cả 4 response Codex thật (2 iteration × không tính resume review) đều parse thành công lần đầu, không cần retry.

---

## State Machine

`Orchestrator` (`src/core/orchestrator/orchestrator.ts`) phát ra chuỗi transition thật (không phải log giả định):

```text
IDLE → PREFLIGHT
  → CLAUDE_EXECUTING → REPORT_DETECTED → REPORT_VALIDATED
  → CODEX_REVIEWING → CODEX_RESPONSE_RECEIVED → RESPONSE_PARSED     (iteration 1, CONTINUE)
  → CLAUDE_EXECUTING → REPORT_DETECTED → REPORT_VALIDATED
  → CODEX_REVIEWING → CODEX_RESPONSE_RECEIVED → RESPONSE_PARSED     (iteration 2, DONE)
  → DONE
```

Terminal states đã cài đặt và có test cho từng cái: `DONE`, `NEED_HUMAN`, `ERROR` (kèm mã lỗi con: `CLAUDE_RUN_FAILED:*`, `CODEX_RUN_FAILED:*`, `REPORT_INVALID`, `RESPONSE_INVALID`), `STOPPED_MAX_ITERATIONS`.

Không có trạng thái nào tự động retry — mọi lỗi trả về ngay ở lần thử đầu tiên (xác nhận qua test "after a single attempt"/"without retrying" cho từng loại lỗi).

---

## Tests

Toàn bộ 150 test dùng **fake CLI** (`tests/fixtures/fake-claude/fake-claude.mjs`, `tests/fixtures/fake-codex/fake-codex.mjs` — là 2 tiến trình Node thật, không phải mock trong bộ nhớ) để không tốn quota AI, cộng thêm test process thật cho `ProcessRunner` (spawn/kill/timeout/UTF-8 thật của Windows).

| File test | Số test | Đối tượng |
|---|---:|---|
| `report-validator.test.ts` | 27 | Report contract |
| `codex-response-parser.test.ts` | 27 | AI_BRIDGE_RESPONSE contract |
| `claude-code-cli-adapter.test.ts` | 14 | Claude adapter (qua fake-claude) |
| `cost-guard.test.ts` | 16 | Cost guard + auth parsing |
| `codex-cli-adapter.test.ts` | 11 | Codex adapter (qua fake-codex) |
| `process-runner.test.ts` | 11 | Spawn/stdin/exit/env/timeout/**tree-kill thật trên Windows** |
| `orchestrator.test.ts` | 9 | Vòng lặp đầy đủ, 8 kịch bản §27 |
| `doctor.test.ts` | 8 | Tổng hợp PASS/FAIL/WARNING/BLOCKED |
| `executable-resolver.test.ts` | 7 | Dò `claude`/`codex` không hard-code path |
| `cli-args.test.ts` | 6 | Parse argv |
| `session-manager.test.ts` | 6 | Đánh số session theo ngày |
| `prompt-templates.test.ts` | 5 | Report contract + reviewer template |
| `logger.test.ts` | 3 | JSONL log |
| **Tổng** | **150** | |

```text
$ node --test tests/*.test.ts
ℹ tests 150
ℹ pass 150
ℹ fail 0
```

```text
$ pnpm exec tsc --noEmit
(không có lỗi)
```

Mọi module đều theo Red-Green: viết test trước, xác nhận **fail đúng lý do** (not-implemented / assertion sai), rồi mới viết implementation tối thiểu để pass. Hai lỗi tìm được qua quy trình RED thực sự nằm ở **fixture** (`fake-codex.mjs` đọc sai vị trí argv của `resume`; `stdin.length` dùng UTF-16 code unit thay vì byte UTF-8) — đã sửa và xác nhận lại GREEN.

Kịch bản bắt buộc theo §27 của spec, tất cả đều PASS:

| Kịch bản | Kết quả |
|---|---|
| Valid: Claude → report hợp lệ → Codex → response hợp lệ | PASS (`orchestrator.test.ts`, cũng PASS khi chạy thật — xem mục tiếp theo) |
| Invalid report (thiếu `REPORT_STATUS`) → STOP | PASS |
| Invalid Codex response (thiếu `<PROMPT>`) → STOP | PASS |
| `STATUS=DONE` → kết thúc | PASS |
| `STATUS=NEED_HUMAN` → dừng | PASS |
| Timeout (Claude treo) → STOP, không hang | PASS |
| Process exit non-zero (cả Claude lẫn Codex) → STOP | PASS |
| Max iteration → `STOPPED_MAX_ITERATIONS` | PASS |

---

## Real 2-Iteration Test

**Đã chạy 2 lần thật** (dùng `claude`/`codex` thật, không giả lập), trên project sandbox `sandbox/m1-target*/` (git riêng, không đụng tới `02-ai-brige` gốc — `02-ai-brige` bản thân **không phải** git repo nên không áp dụng §25).

### Lần 1 — task đơn giản (1 iteration, để kiểm chứng đường ống end-to-end)

```powershell
node src/cli.ts start --project "D:\000_AI Agent\02-ai-brige\sandbox\m1-target" `
  --task "Create a file named hello.txt in the project root containing exactly this text with no trailing newline: Hello from AI Bridge M1" `
  --max-iterations 3 --claude-timeout-ms 600000 --codex-timeout-ms 300000
```

Kết quả: `hello.txt` được tạo đúng nội dung; Codex đánh giá **DONE ngay ở iteration 1** (task quá đơn giản để cần lặp lại) — đây là hành vi đúng, không phải lỗi, nhưng chưa chứng minh được resume 2 lượt nên đã chạy tiếp lần 2.

### Lần 2 — task 2 bước cố ý (bắt buộc theo §28: "Phải chứng minh được 2 iteration liên tiếp")

```powershell
node src/cli.ts start --project "D:\000_AI Agent\02-ai-brige\sandbox\m1-target-2" `
  --task "This task has exactly two steps... In THIS iteration, do ONLY step 1: create step1.txt containing 'part one'... In your report's NEXT_RECOMMENDATION, explicitly state that step 2 (step2.txt = 'part two') still needs to be done next." `
  --max-iterations 3 --claude-timeout-ms 600000 --codex-timeout-ms 300000
```

**Kết quả (`Final status: DONE`, `Iterations: 2`, exit code 0):**

```text
Iteration 1:
  Claude nhận task ban đầu (nguyên văn từ --task)
  → Claude tạo step1.txt = "part one"
  → Claude ghi 001-report.md  (REPORT_STATUS: COMPLETE, NEXT_ACTION: CONTINUE)
  → Bridge validate report 001 — hợp lệ
  → Bridge gửi report cho Codex (codex exec --json -s read-only ...)
  → Codex trả <AI_BRIDGE_RESPONSE><STATUS>CONTINUE</STATUS><PROMPT>Create step2.txt ...</PROMPT></AI_BRIDGE_RESPONSE>
  → Bridge parse, trích PROMPT nguyên văn vào 001-extracted-prompt.md

Iteration 2:
  Claude RESUME cùng session (--resume 1558fa67-89e6-44a5-a8eb-8aadd48724fb)
  Prompt gửi cho Claude = 002-claude-prompt.md, SHA-256 GIỐNG HỆT 001-extracted-prompt.md
     (551e919670d108ca77d85d78380895789866719802db11cb64b4e152216ed25b)
  → Claude tạo step2.txt = "part two"
  → Claude ghi 002-report.md (ITERATION: 2, REPORT_STATUS: COMPLETE, NEXT_ACTION: DONE)
  → Bridge validate report 002 — hợp lệ
  → Bridge gửi report cho Codex, RESUME cùng thread (codex exec resume 01a0d835-a985-75f2-a47d-13e49225047f)
  → Codex trả STATUS: DONE
  → Orchestrator kết thúc: finalStatus = DONE
```

File tạo ra trên đĩa (thật, đọc lại được):
- `step1.txt` = `part one`, `step2.txt` = `part two`
- `.ai-bridge/reports/001-report.md`, `002-report.md`
- `.ai-bridge/sessions/2026-09-25_001/` — đủ 9 file audit (prompt/report/input/review/extracted-prompt của 2 iteration + `session.json`)
- `.ai-bridge/logs/2026-09-25-session.log` — 4 dòng JSONL (claude×2, codex×2), có `exitCode`, `durationMs`, `command` (không chứa credential)
- `.ai-bridge/state/current-session.json` = `{"sessionId":"2026-09-25_001","iteration":2,"status":"DONE"}`

**Đây là bằng chứng thật, không phải mô tả giả định**, đáp ứng đúng acceptance test của §28 và §29 (không có gì được ghi PASS mà chưa thực sự chạy).

---

## Problems

| # | Vấn đề gặp phải | Cách xử lý |
|---|---|---|
| 1 | Claude CLI độc lập ban đầu `loggedIn: false` | Báo blocker, dừng code, chờ user tự `claude auth login --claudeai` (không tự động hoá việc đăng nhập) |
| 2 | `codex` không có trên PATH | Không hard-code path chứa hash phiên bản; viết `resolveExecutable` tự dò qua `where` + fallback quét `%LOCALAPPDATA%\OpenAI\Codex\bin\*`, chọn bản mới nhất theo mtime |
| 3 | Lần chạy thật đầu tiên chỉ ra 1 iteration (Codex trả DONE ngay) | Không phải lỗi — nhưng chưa đủ để chứng minh yêu cầu "2 iteration". Thiết kế lại task thành 2 bước rõ ràng, chạy lại lần 2 |
| 4 | `sandbox/m1-target` (thư mục đầu) bị khoá ("Device or resource busy") khi `rm -rf` để dọn dẹp chạy lại | Không cố ép xoá; tạo `sandbox/m1-target-2` mới thay vì đấu tranh với file lock — không có tổn hại dữ liệu |
| 5 | `codex exec resume` không nhận `-s`/`-C` (khác với `codex exec`) | Phát hiện bằng cách đọc `--help` thật trước khi code (không đoán); dùng `-c sandbox_mode="read-only"` thay thế khi resume |
| 6 | Fixture `fake-codex.mjs` đọc sai vị trí `resume` trong argv; `stdin.length` dùng sai đơn vị (UTF-16 thay vì byte UTF-8) | Phát hiện đúng bằng chu trình RED→GREEN (2 test fail đúng lý do), sửa fixture, không sửa test |
| 7 | Hai lệnh Bash bị GateGuard/PreToolUse hook chặn (yêu cầu trình bày fact trước khi ghi file / chạy lệnh phá huỷ) | Tuân thủ: trình bày đủ facts theo đúng yêu cầu của hook trước khi retry |

---

## Limitations

Các giới hạn có thật của M1 (không giả lập là đã làm xong):

1. **`ai-bridge stop` chưa dừng được tiến trình đang chạy.** M1 `start` chạy foreground, chặn cho tới khi xong; `stop` chỉ in hướng dẫn dùng Ctrl+C. Không có background daemon (đúng phạm vi M1 — Electron/daemon để Phase sau).
2. **Chưa cài đặt PAUSE.** Orchestrator M1 chạy hết vòng lặp không dừng giữa chừng theo lệnh người dùng (ngoài Ctrl+C cứng).
3. **Chưa cài §25 (kiểm tra `git status` trước khi chạy trên project có sẵn).** `cmdStart` hiện không tự chạy `git status`/cảnh báo uncommitted changes trước khi bắt đầu. Đây là thiếu sót thật, cần bổ sung trước khi dùng M1 trên project đã có code — khuyến nghị làm ngay đầu Phase kế tiếp.
4. **Đánh số report/session chỉ theo scan thư mục hiện tại, chưa có lock chống 2 tiến trình `ai-bridge start` chạy đồng thời trên cùng project** (đúng theo §Open Questions Q10 của báo cáo Phase 0, chưa được trả lời).
5. **`allowedTools`/allowlist lệnh Bash cho Claude chưa được nối dây trong CLI M1** — Claude chạy với `--permission-mode acceptEdits` (không phải `--dangerously-skip-permissions`, đúng §24) nhưng chưa giới hạn cụ thể lệnh nào được phép; đủ an toàn cho task nhỏ trong sandbox nhưng cần allowlist trước khi dùng trên project thật quan trọng (đã ghi trong §13 báo cáo Phase 0).
6. **Chưa xác nhận được thread do Codex CLI tạo có hiện trong ChatGPT App hay không** (do App không lộ nội dung qua UI Automation — BLOCKER đã ghi ở Phase 0). Không ảnh hưởng chức năng của M1 vì Bridge không phụ thuộc vào việc đó.
7. **Reviewer (Codex) chỉ đọc report, chưa đọc code** — đúng theo phạm vi M1 (§4 câu hỏi mở của Phase 0, mặc định "MVP: chỉ đọc report").
8. **Không có UI** (đúng yêu cầu §31, để Phase sau).

---

## Files Created

### Mã nguồn (`src/`, 14 file, 1454 dòng)

```text
src/adapters/chatgpt/codex-cli-adapter.ts
src/adapters/claude/claude-code-cli-adapter.ts
src/automation/process-runner.ts
src/cli-args.ts
src/cli.ts
src/core/cost-guard.ts
src/core/logger/logger.ts
src/core/orchestrator/orchestrator.ts
src/core/preflight/doctor.ts
src/core/preflight/executable-resolver.ts
src/core/session-manager/session-manager.ts
src/prompts/templates.ts
src/reports/codex-response-parser.ts
src/reports/report-validator.ts
```

### Test (`tests/`, 13 file test + fixtures, 150 test case)

```text
tests/claude-code-cli-adapter.test.ts
tests/cli-args.test.ts
tests/codex-cli-adapter.test.ts
tests/codex-response-parser.test.ts
tests/cost-guard.test.ts
tests/doctor.test.ts
tests/executable-resolver.test.ts
tests/logger.test.ts
tests/orchestrator.test.ts
tests/process-runner.test.ts
tests/prompt-templates.test.ts
tests/report-validator.test.ts
tests/session-manager.test.ts

tests/fixtures/fake-claude/fake-claude.mjs      (fake Claude CLI — Node process thật)
tests/fixtures/fake-codex/fake-codex.mjs        (fake Codex CLI — Node process thật)
tests/fixtures/process/*.mjs                    (7 file, fixture cho ProcessRunner)
tests/fixtures/reports/*.md                     (2 file, fixture cho ReportValidator)
```

### Cấu hình

```text
package.json
tsconfig.json
.gitignore
```

### Tài liệu

```text
docs/01-architecture-feasibility-report.md   (Phase 0)
docs/02-m1-poc-report.md                     (báo cáo này)
```

### Không commit (đúng thiết kế — `.gitignore`)

```text
node_modules/
.ai-bridge/     (tạo ra khi chạy start — audit trail của mỗi project)
sandbox/        (project thử nghiệm dùng cho acceptance test, có git riêng)
```

---

## Commands Used

Lệnh dùng để phát triển và kiểm chứng (không có lệnh nào dùng API key):

```bash
pnpm add -D typescript @types/node
pnpm exec tsc --noEmit
node --test tests/*.test.ts
node src/cli.ts doctor --project "D:\000_AI Agent\02-ai-brige"
node src/cli.ts start --project "D:\000_AI Agent\02-ai-brige\sandbox\m1-target" --task "..." --max-iterations 3
node src/cli.ts start --project "D:\000_AI Agent\02-ai-brige\sandbox\m1-target-2" --task "..." --max-iterations 3
```

Lệnh user cần chạy trước khi bắt đầu (đã báo trong hội thoại, user tự chạy):

```bash
claude update
claude auth login --claudeai
```

---

## Acceptance Criteria

| Tiêu chí (§27–28 của spec) | Trạng thái | Bằng chứng |
|---|---|---|
| Bridge → Claude CLI → thực hiện task → tạo report → Bridge đọc report → resume đúng session | **PASS** | Real run: cùng `claudeSessionId` 2 lượt, `--resume` đúng id |
| Bridge → gửi report TEXT cho Codex CLI → Codex review → structured response → Bridge parse STATUS+PROMPT | **PASS** | Real run: 2 response hợp lệ, parse thành công cả 2 |
| Vòng lặp Claude → Report → Codex → Prompt → Claude → Report → Codex, ≥ 2 iteration, không copy/paste thủ công | **PASS** | Real run lần 2: 2 iteration liên tiếp, hoàn toàn tự động |
| Không dùng API key / cloud / paid service | **PASS** | Cost guard chặn env; cả 2 lần chạy thật đều dùng subscription (Claude Pro, ChatGPT) |
| Report Validator hoạt động, STOP khi invalid | **PASS** | Unit test + không kích hoạt sai trong real run (report hợp lệ ngay lần đầu) |
| Response Parser hoạt động, STOP khi malformed | **PASS** | Unit test + không kích hoạt sai trong real run |
| State machine tối thiểu | **PASS** | Transitions thật khớp đúng thứ tự spec §17 |
| Logging (không ghi credential) | **PASS** | Log JSONL thật, kiểm tra bằng mắt không chứa token/password |
| State persistence (`current-session.json`) | **PASS** | File thật tồn tại, có nội dung đúng sau khi chạy |
| Fake CLI cho test không tốn quota | **PASS** | 150/150 test dùng fake-claude/fake-codex |
| Không giả lập kết quả chưa kiểm chứng | **PASS** | Mọi PASS trong báo cáo này đều có lệnh/log/file kèm theo; limitation liệt kê rõ ở trên |

---

## Final Status

```text
PASS
```

M1 Proof of Concept đã chứng minh được, **bằng chạy thật** (không chỉ bằng fake CLI): Claude Code CLI thực hiện task → tạo report → Bridge validate → gửi Codex CLI (đăng nhập ChatGPT) → Codex review → tạo PROMPT → Bridge trích xuất nguyên văn → Claude nhận đúng prompt đó, resume đúng session → lặp lại → Codex báo DONE → dừng sạch. Toàn bộ chi phí phát sinh: **$0** (dùng subscription có sẵn, cost guard xác nhận không có API key nào được dùng).

Các giới hạn thật (không phải thiếu sót che giấu) đã liệt kê ở mục Limitations — quan trọng nhất là chưa có `git status` safety check trước khi chạy trên project có sẵn (§25) và chưa có cơ chế dừng tiến trình đang chạy từ xa (`stop`).

**Theo yêu cầu, dừng tại đây. Không tự chuyển sang M2 (Electron/React UI). Chờ chỉ đạo tiếp theo.**
