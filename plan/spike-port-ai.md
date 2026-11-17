# Spike port AI (phase 1)

- **Ngày lập:** 2026-11-17
- **Trả lời:** [rủi ro 1, 2](05-rui-ro.md); chốt hình dạng port ở [mục 3.3](03-kien-truc.md)
- **Xong thì:** kết luận chuyển vào `03-kien-truc.md` (mục 3.3), `02-ky-thuat.md` (mục 2.4), cột cách xử lý của rủi ro 1, 2; file này chuyển vào `archive/`

## Tài liệu hiện hành (tra ngày 2026-11-17)

| Thư viện | Phiên bản | Ghi chú cho spike |
| --- | --- | --- |
| `@tanstack/ai` | 1.4.0 (ổn định từ 1.0) | `chat({ adapter, messages, threadId, tools, systemPrompts, outputSchema, abortController, agentLoopStrategy })` trả async iterable sự kiện kiểu AG-UI, kết thúc bằng `RUN_FINISHED` hoặc `RUN_ERROR`. Tool là `toolDefinition({ inputSchema, outputSchema }).server(fn)`, nhận Standard Schema |
| `@tanstack/ai-anthropic`, `-openai`, `-gemini` | 1.1.1, 1.1.1, 1.2.2 | Endpoint tương thích OpenAI dùng `openaiCompatible` trong `@tanstack/ai-openai/compatible` |
| `@tanstack/ai-effect` | 0.1.1 (0.x) | Cầu nối với Effect v4. Còn 0.x, cần đánh giá trước khi dùng |
| `@agentclientprotocol/sdk` | 2.7.0, protocol 1 | Client spawn agent qua stdio. Tool của kd-learn đưa vào bằng MCP trong `session/new` (stdio luôn có; http khi agent báo `mcpCapabilities.http`). Không có cơ chế output theo JSON schema |
| `@agentclientprotocol/claude-agent-acp` | 0.107.3 | Thay cho `@zed-industries/claude-code-acp` (đã deprecated) |
| Antigravity CLI | `agy acp` (ACP từ v1.5.0) | Đăng nhập trước bằng `agy` hoặc `agy acp --login`. Chưa rõ có nhận MCP và `systemPrompt` từ `session/new` không |
| opencode | `opencode acp` | Cấu hình MCP lấy từ config của opencode, cần kiểm có nhận MCP từ `session/new` không |

Không dùng Gemini CLI (`gemini --acp`): đã bị Antigravity CLI thay thế.

## Port (bản nháp, sẽ chốt sau spike)

`@kd-learn/ai/port`: một hàm `runTurn(request): Stream<TurnEvent, AiError>` (Effect).

- **`TurnRequest`:** backend và model, system prompt, lịch sử tin nhắn, danh sách tool (tên, mô tả, input là Effect Schema, hàm chạy là Effect), schema kết quả có cấu trúc (không bắt buộc).
- **`TurnEvent`:** `text-delta`, `tool-call`, `tool-result`, `structured-result` (đã validate bằng Effect Schema), `usage`, `finish` (lý do dừng). Lỗi đi qua kênh lỗi của Stream, có kiểu.
- Huỷ Stream (fiber bị interrupt) phải dừng request tới provider hoặc gửi `session/cancel` tới agent.

## Việc cần kiểm

**A. Backend API (TanStack AI), [rủi ro 2](05-rui-ro.md):**

1. Effect Schema dùng được làm `inputSchema` của tool và `outputSchema` qua `Schema.toStandardSchemaV1`, kể cả sinh JSON Schema gửi cho provider.
2. `outputSchema` dùng chung với tool khi stream: nhận được `structured-output.complete` sau các lượt gọi tool.
3. Chuyển async iterable sang `Stream` của Effect: interrupt thì huỷ qua `abortController`, không rò request; lỗi `RUN_ERROR` ánh xạ sang lỗi có kiểu.
4. So sánh `@tanstack/ai-effect` với tự viết lớp chuyển đổi; chọn một.
5. Chạy được với Anthropic, OpenAI, Gemini và một endpoint tương thích OpenAI.

**B. Backend ACP, [rủi ro 1](05-rui-ro.md):**

1. Spawn `claude-agent-acp`, `agy acp` và `opencode acp`, đi hết `initialize` → `session/new` → `session/prompt` → `session/update`.
2. Đưa tool của kd-learn vào qua một MCP server do kd-learn chạy; agent gọi được.
3. Output có cấu trúc: bắt agent gọi tool `submit_result` có schema, server validate; sai thì trả lỗi để agent sửa.
4. Chặn tool có sẵn của agent (sửa file, shell): không khai báo capability `fs` và `terminal`, từ chối mọi `session/request_permission`, `cwd` là thư mục tạm rỗng. Kiểm agent không ghi được ra ngoài thư mục đó.
5. `session/cancel` khi Stream bị interrupt; process agent được dọn khi xong.
6. Ánh xạ `session/update` (`agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`) sang `TurnEvent`.

## Tiêu chí đạt (chốt 2026-11-17)

- **Rủi ro 2 đạt** khi A1–A3 chạy được với ít nhất Anthropic, có test cho interrupt. OpenAI, Gemini, endpoint tương thích OpenAI chạy được thì ghi lại, không bắt buộc.
- **Rủi ro 1 đạt** khi B1–B3 chạy được với cả ba agent: Claude Code, Antigravity CLI, opencode (dùng gói OpenCode Go). Mỗi agent cho kết quả hợp lệ ở ít nhất 19/20 lượt (cho phép một lần sửa sau lỗi validate). Agent nào không đạt thì chỉ dùng cho vai không cần cấu trúc chặt, như đã ghi ở rủi ro 1.
- **B4 (chặn tool có sẵn):** agent nào không chặn được thì ghi lại trước (cách đã thử, tool nào còn chạy được) thành rủi ro mới; chưa quyết định chặn ACP trong spike.

## Không làm trong spike

UI, DB, auth, lưu lịch sử. Mã spike nằm trong `packages/ai` (port + adapter) và một script chạy thử; test chạy với provider thật chỉ chạy tay, không chạy trong CI.

## Cần chuẩn bị

- API key Anthropic, OpenAI, Gemini (biến môi trường, không commit) cho phần A.
- Claude Code đã đăng nhập cho `claude-agent-acp`, Antigravity CLI đã đăng nhập, opencode đã đăng nhập gói OpenCode Go cho phần B. Cả ba đã cài trên máy dev.
