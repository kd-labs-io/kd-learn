# 8. Tiến độ phase 3

**Trạng thái: đang làm.** Plan phần chính: [luyen-tap-graph.md](../luyen-tap-graph.md).

## Phase 3 (cập nhật 2026-11-21)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-21). Chốt: một graph mỗi người, demo dùng được graph và luyện tập (tính chung ngân sách), bốn loại bài tập đầu tiên |
| Bước 0: spike hình graph (C1) | Chưa bắt đầu |
| Bước 1: spike extraction với Haiku (C2, C3) | Xong (2026-11-21). Pipeline 3 lần gọi (extractor, auditor kiểm cả mệnh đề và cạnh, merge theo ứng viên của từng mệnh đề), chọn lát theo từ vựng K = 5 mỗi mệnh đề, giữ 5 quan hệ. Không dùng TanStack DB. Khoảng $0,007 mỗi buổi với Haiku. Xem ghi chú bước 1 bên dưới |
| Bước 2: log kiến thức (core, storage) | Chưa bắt đầu |
| Bước 3: hồ sơ dạy học v2, vai mới | Chưa bắt đầu |
| Bước 4: pipeline extraction (agent) | Chưa bắt đầu |
| Bước 5: extraction trên server | Chưa bắt đầu |
| Bước 6: registry bài tập, Practitioner | Chưa bắt đầu |
| Bước 7: luyện tập trên server | Chưa bắt đầu |
| Bước 8: model giả trả tool call | Chưa bắt đầu |
| Bước 9: màn graph | Chưa bắt đầu |
| Bước 10: màn luyện tập | Chưa bắt đầu |
| Bước 11: màn sửa hồ sơ | Chưa bắt đầu |
| Bước 12: kiểm tiêu chí phase | Chưa bắt đầu |

## Điều cần biết khi bắt đầu (từ handoff sau phase 2)

- **Hai chế độ lưu:** mọi thứ mới phải chạy ở cả khách / demo (DB local, server không trạng thái, `/api/turns`) và tài khoản (SQLite server, lượt tách khỏi request, stream gắn lại theo `seq`, `/api/account/sessions/*`). Mọi truy cập dữ liệu tài khoản đi qua `forUser(userId)`.
- **Migration:** khách ở `packages/storage/src/sqlite/schema.ts`, server có danh sách riêng ở `packages/storage/src/sqlite-node/schema.ts`. Không sửa migration đã phát hành.
- **Thêm vai:** sửa `ModelRole` / `RoleModels` trong `packages/api/src/contract.ts`, màn `apps/web/src/account/AccountSettings.tsx`, cách khách chọn model (`apps/web/src/learn/runner.ts`), `AgentRole` trong `packages/core/src/profile.ts`.
- **Màn mới** theo mẫu `LessonSource` (`apps/web/src/learn/source.ts`): một interface nguồn dữ liệu, hai cài đặt. Dữ liệu tài khoản qua TanStack Query, `QueryClient` tạo theo router.
- **Lượt tự chạy:** server nối lượt lập plan ngay trong cùng lượt; `shouldAutoStart` ở `@kd-learn/agent/client`. Extraction sau buổi học (A3) cần xem lại cách server nối việc sau lượt trong `packages/server/src/sessions/runner.ts`. Client gọi `auto` bị `409 TurnInProgress` / `NothingToRun` thì bỏ qua.
- **Test e2e:** Playwright chạy trên bản build thật: server khách cổng 4173, server tài khoản cổng 4174 (DB tạm), model giả tương thích OpenAI cổng 4175 (`apps/web/e2e/fake-openai.ts`: giữ lượt có chữ `hold` tới khi test thả; lượt mở đầu trả "What do you already know?"). Bước 8 mở rộng để trả tool call.
- **Env mới** của server: thêm vào `.env.example` và bảng trong `docs/deploy.md`; CI job `docker` chạy `scripts/compose-smoke.sh`.
- **ACP:** `acpAvailable` phụ thuộc nơi chạy (bản build trong repo nạp được adapter, Docker thì không).
- **Kiểm trước khi mở PR:** `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`; `cd apps/web && pnpm build && npx playwright test --project=chromium`; đụng Docker hay env thì `./scripts/compose-smoke.sh`. Firefox chập chờn khi chạy song song ở máy local; CI chỉ chạy Chromium.
- **Quy ước:** mỗi bước một nhánh, một PR; CI xanh thì tự merge. Không format file trong `plan/` (nằm trong `.prettierignore`; đừng chạy prettier khi đang đứng trong `plan/`). Secret trong `.env` không in, không commit. Model thật tối đa một lần kiểm mỗi bước.
- **Xong mỗi bước:** cập nhật bảng trên và ghi chú của bước, một dòng `changelog.md`, mục 7 trong `06-viec-mo.md`, rủi ro liên quan trong `05-rui-ro.md`.

## Bước 1: spike extraction với Haiku (C2, C3) (2026-11-21)

Thử bằng script tạm trong `packages/server/spike/` (không giữ trong repo), gọi `AiPort` thật qua adapter TanStack (`@kd-learn/ai/tanstack`), model `claude-haiku-5-5`, output có cấu trúc bằng Effect Schema.

### Dữ liệu

Không còn log buổi học thật từ phase 1–2 (DB khách ở OPFS của trình duyệt, stack Compose đã xoá). Tạo ba buổi mới bằng vòng agent thật (`runTurn`, hồ sơ mặc định); người học do Haiku đóng vai (persona biết một phần, trả lời 1–3 câu, có lúc sai):

| Buổi | Chủ đề | Lượt | Event | Token vào / ra |
| --- | --- | --- | --- | --- |
| `bsearch` | Binary search | 21 | 93 | 150k / 11k |
| `complexity` | Big-O, độ phức tạp của tìm kiếm và sắp xếp | 19 | 85 | 143k / 11k |
| `bayes` | Định lý Bayes | 14 | 65 | 88k / 8k |

`complexity` cố ý trùng một phần với `bsearch` để thử merge; `bayes` không liên quan, để thử gộp nhầm. Cả ba buổi tới `Done`; token trên gồm cả lượt của người học giả.

### C2. Chất lượng và chi phí

**Extractor** (một lần gọi, bản ghi buổi gồm chủ đề, đánh giá, plan, các lượt):

- 12 / 16 / 10 mệnh đề, 10 / 14 / 12 cạnh. Mọi mệnh đề đều đúng, tự đứng được, một ý; không thấy mệnh đề bịa. Có vài mệnh đề là ví dụ cụ thể của buổi (vết chạy binary search trên `[2, 4, 7, 9, 11]`, lá bài cơ hay đỏ): chấp nhận được vì đều nối `exampleOf` tới mệnh đề tổng quát, và có ích làm bài tập.
- Cạnh kém hơn mệnh đề: khoảng 6/36 cạnh ngược chiều hoặc sai quan hệ (ví dụ `log-worst-case implies halvings-log` ngược chiều, một cặp nối hai chiều thừa). `requires` và `exampleOf` dùng nhất quán nhất; `implies` và `supports` hay bị dùng lẫn.

**Auditor:**

- Trên đề xuất thật: không bỏ mệnh đề nào, sửa 5/38 (đều là tách câu chứa hai ý; khi sửa thì ý thứ hai bị mất, nên prompt cần cho phép tách thành hai mệnh đề).
- Cài 6 đề xuất sai vào danh sách của `bsearch` (công thức sai, khẳng định sai, chưa được dạy, chuyện riêng của buổi, mơ hồ, trùng): bỏ đủ 6/6, không bỏ nhầm mệnh đề thật nào.
- Kiểm cạnh (một lần gọi riêng cho thử nghiệm): sửa được mọi cạnh sai đã đánh dấu bằng tay (đảo chiều, đổi quan hệ) và bỏ các cạnh lặp. Kết luận: **auditor đáng một lần gọi riêng, và kiểm cả mệnh đề lẫn cạnh trong cùng lần gọi đó.**

**Merge** (đồ thị có sẵn = `bsearch` + `bayes`, 22 mệnh đề; trích `complexity` vào, 16 mệnh đề):

- Cách 1, đưa toàn bộ mệnh đề có sẵn, prompt "nghi ngờ thì chọn new": không ổn định. Hai lần chạy cho hai kết quả khác nhau (1 cặp gộp và 0 cặp gộp), và cả hai đều bỏ sót cặp gần như trùng (`halving-log` / `halvings-log`).
- Cách 2, mỗi mệnh đề mới kèm **K = 5 ứng viên** chọn theo từ vựng (tập từ bỏ stopword, độ tương tự cosine nhị phân), định nghĩa "same" là "biết câu này thì biết câu kia": 3/3 lần gộp đúng `halving-log`, kết quả gộp giống nhau cả ba lần. Trích `bayes` vào đồ thị `bsearch` + `complexity`: 3/3 lần không gộp gì (không gộp nhầm).
- Chọn ứng viên theo từ vựng: cặp trùng thật nằm trong top 3 của mệnh đề đó. Cỡ mẫu nhỏ (đồ thị 22–28 mệnh đề); với vài nghìn mệnh đề, chọn theo từ vựng có thể sót khi hai câu dùng từ khác nhau. Theo dõi ở [rủi ro 32](../05-rui-ro.md).
- Số cạnh merge thêm dao động 6–11 giữa các lần chạy; cạnh không trỏ tới id ngoài lát (đã kiểm).

**Token và chi phí** (một buổi, theo `Usage` của port; output gồm cả thinking của Haiku 5.5):

| Lần gọi | Vào | Ra |
| --- | --- | --- |
| Extractor | 5,4k–6,8k | 1,4k–4,4k |
| Auditor (mệnh đề) | 5,9k–7,8k | 1,8k–2,7k |
| Auditor (cạnh) | 2,0k–2,6k | 1,5k–2,5k |
| Merge (K = 5) | 5,0k–7,4k | 1,1k–3,7k |

- Cả pipeline khoảng 20–25k token vào, 7–12k ra mỗi buổi, tức khoảng **$0,007 mỗi buổi** theo giá Haiku 5.5 hiện hành ($0,10 / $0,50 mỗi MTok). Một buổi dạy khoảng $0,01–0,02, nên extraction tăng chi phí một buổi khoảng 40–60%.
- **Trần 2.048 token ra mỗi lần gọi của demo không đủ:** extractor ra tới 4,4k token (phần lớn là thinking; JSON chỉ khoảng 1k). Demo cần trần riêng cho vai `extractor` (đề xuất 8.192), vẫn giữ chỗ và quyết toán như phase 2. Ghi vào [rủi ro 33](../05-rui-ro.md), làm ở bước 5.
- Thân request: lát K = 5 cho 16 mệnh đề khoảng 30 KB, dưới 256 KiB của demo.
- Toàn bộ spike (ba buổi và mọi lần trích) tốn dưới $0,10.
- Chưa thử ACP (`submit_result` với mảng dài): không cần cho các bước tới; thử khi có máy chạy ACP.

### C3. TanStack DB

- `@tanstack/db` và `@tanstack/react-db` vẫn là `1.0.0-rc.1.5` (npm, 2026-11-21).
- Không cần live query: log kiến thức đọc một lần rồi dựng projection trong bộ nhớ (vài nghìn mệnh đề), làm mới khi có `KnowledgeChanged` (khách) hoặc khi Query làm mới (tài khoản), giống màn học. Không dùng TanStack DB ở phase 3.

### Quyết định (ghi vào [luyen-tap-graph.md](../luyen-tap-graph.md))

- **Pipeline 3 lần gọi:** extractor → auditor (mệnh đề và cạnh, cho phép tách một mệnh đề hai ý thành hai) → merge theo ứng viên của từng mệnh đề.
- **Quan hệ:** giữ 5 quan hệ `requires`, `implies`, `supports`, `exampleOf`, `contrastsWith`, kèm định nghĩa đọc theo câu "from RELATION to" trong prompt. Cấm chu trình trên `requires` và `implies` (chuỗi lập luận cho bài sắp xếp đi theo hai quan hệ này). `contrastsWith` không có hướng: projection coi hai chiều là một cạnh.
- **Lát:** K = 5 ứng viên mỗi mệnh đề mới, lấy hợp; trần tổng 200 mệnh đề và theo số byte.
