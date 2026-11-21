# 8. Tiến độ phase 3

**Trạng thái: đang làm.** Plan phần chính: [luyen-tap-graph.md](../luyen-tap-graph.md).

## Phase 3 (cập nhật 2026-11-21)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-21). Chốt: một graph mỗi người, demo dùng được graph và luyện tập (tính chung ngân sách), bốn loại bài tập đầu tiên |
| Bước 0: spike hình graph (C1) | Xong (2026-11-21). TanStack Charts không có kéo node; chọn sigma 4 + graphology (WebGL, kéo 60 fps với 3.000 node). Xem ghi chú bước 0 bên dưới |
| Bước 1: spike extraction với Haiku (C2, C3) | Xong (2026-11-21). Pipeline 3 lần gọi (extractor, auditor kiểm cả mệnh đề và cạnh, merge theo ứng viên của từng mệnh đề), chọn lát theo từ vựng K = 5 mỗi mệnh đề, giữ 5 quan hệ. Không dùng TanStack DB. Khoảng $0,007 mỗi buổi với Haiku. Xem ghi chú bước 1 bên dưới |
| Bước 2: log kiến thức (core, storage) | Chưa bắt đầu |
| Bước 3: hồ sơ dạy học v2, vai mới | Xong (2026-11-21). `TeachingProfile` thêm `name` và bốn prompt tuỳ chọn, `resolveProfile` điền từ hồ sơ mặc định; hồ sơ lưu qua port ở cả hai driver; `GET` / `PUT` / `DELETE /api/account/profile`; vai `practitioner` / `extractor` chưa đặt thì dùng model của `teacher`. Xem ghi chú bước 3 bên dưới |
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

## Bước 0: spike hình graph, C1 (2026-11-21)

Thử nghiệm bằng prototype tạm (thư mục scratch ngoài repo, không giữ, không thêm dependency vào repo) trên macOS, Chromium của Playwright 1.65.1. Graph giả: 3.000 node, 4.000 cạnh có hướng có nhãn, 30 cụm (85 % cạnh trong cụm), seed cố định. Kéo node: Playwright giữ chuột trên một node và di 60 bước; đếm `requestAnimationFrame` trong lúc kéo (trang trống đo được 61 fps). CPU chậm: CDP `Emulation.setCPUThrottlingRate` 4x. Bundle: esbuild, minify, gzip.

### Tài liệu hiện hành (tra ngày 2026-11-21, từ npm và tài liệu đóng gói trong package)

| Thư viện | Phiên bản | Giấy phép | Ghi chú |
| --- | --- | --- | --- |
| `@tanstack/charts` | 1.5.0 (đã qua 1.0, theo hợp đồng tương thích của bản 1.x trong `docs/compatibility.md` của package) | MIT | Có trang "Networks and Hierarchies": `forceLayout` (`@tanstack/charts/network/force`) chạy mô phỏng D3 force **tĩnh, đồng bộ**, trả hàng dữ liệu cho mark thường (`dot`, `arrow`, `text`, `link`). Có Sankey, tree, Delaunay. Renderer SVG (mặc định) và Canvas 2D. Có focus, chọn (`selection`), bàn phím, pan / zoom. **Không có kéo node**: tài liệu chỉ có kéo cho brush / pan, kéo dữ liệu là việc của ứng dụng (tự xử lý pointer rồi dựng lại definition) |
| `sigma` + `graphology` | 4.0.6 + 0.26.0 | MIT | WebGL, "graphs of thousands of nodes and edges" ([sigmajs.org](https://www.sigmajs.org)). Mũi tên qua `primitives.edges.extremities: [extremityArrow()]` (`sigma/rendering`), nhãn cạnh qua `renderEdgeLabels`. Sự kiện `downNode` / `moveBody` / `upStage` để kéo; có `MouseCaptor`, `TouchCaptor`; trạng thái `hidden`, `highlighted` theo node để chỉ hiện lân cận. Không có xử lý bàn phím (không có `keydown` trong bundle). Màu là chuỗi trong thuộc tính node, không đọc `var(--...)`: phải đọc token bằng `getComputedStyle` và gán lại khi đổi theme |
| `graphology-layout-forceatlas2` | 0.10.1 | MIT | Bố cục ForceAtlas2, có bản chạy trong Web Worker (`worker.js`) |
| `@react-sigma/core` | 6.0.0 | MIT | Binding React cho sigma 4 (peer `react ^18 \|\| ^19`). Không cần cho spike |
| `cytoscape` | 3.35.0 | MIT | Canvas 2D. Mũi tên, nhãn cạnh, kéo node có sẵn. Không có xử lý bàn phím |
| `@xyflow/react` | 13.0.2 | MIT | "Library for building node-based editors": mỗi node là phần tử DOM React. Không đo: nhắm tới editor vài chục tới vài trăm node, không hợp vài nghìn |
| `reagraph` | 4.32.0 | Apache-2.0 | Không xét thêm (WebGL qua three.js, giấy phép khác MIT) |

### Kết quả đo (3.000 node, 4.000 cạnh)

| | Bundle (gzip) | Bố cục | Render đầu | Kéo node | Heap JS |
| --- | --- | --- | --- | --- | --- |
| TanStack Charts (Canvas, `forceLayout` 300 vòng) | 42 KiB | 2,1 s (4x: 8,6 s) | 69 ms | Không có sẵn; tự kéo = dựng lại definition: **50 ms mỗi lần di** (4x: 200 ms), tức tối đa khoảng 20 fps (4x: 5 fps) chưa tính vẽ | 87 MiB |
| sigma 4 + graphology (WebGL, ForceAtlas2 100 vòng, Barnes-Hut) | 116 KiB | 0,8 s (4x: 3,3 s) | 1,0 s lần đầu có GPU (gồm tạo context WebGL) | **61 fps** (4x: 62 fps) với GPU thật; 11 fps khi WebGL chạy phần mềm (SwiftShader) | 58 MiB |
| cytoscape (Canvas, bố cục `cose` 300 vòng) | 142 KiB | **48 s** (4x: 195 s) | — | 45 fps (4x: 12 fps) | 104 MiB |

- Bố cục của cả ba chạy trên luồng chính trong prototype. TanStack `forceLayout` đo riêng trong Node: 0,76 s với 100 vòng, 2,3 s với 300 vòng.
- WebGL chạy phần mềm (máy không có GPU, một số VM) làm sigma tụt còn 11 fps khi kéo; điện thoại thật đều có GPU, nhưng chưa thử trên máy thật (phase 6).

### Kết luận C1

- **TanStack Charts không đạt cho hình graph:** có bố cục force và mark mũi tên / chữ, nhưng không có kéo node; tự kéo bằng cách dựng lại cả scene tốn 50 ms mỗi lần di trên máy tính, 200 ms khi CPU chậm 4x. Vẫn dùng TanStack Charts cho các biểu đồ khác (tiến độ, mức nắm vững, hạn mức demo).
- **Cytoscape loại:** bố cục `cose` mất 48 s với 3.000 node.
- **Chọn sigma 4 + graphology** (+ ForceAtlas2): MIT, WebGL, kéo 60 fps cả khi CPU chậm 4x, bố cục 0,8 s (3,3 s khi chậm 4x). Ở bước 9:
  - chạy ForceAtlas2 trong Web Worker (bản `worker` của package), không chặn luồng chính;
  - nạp lười bằng `import()` chỉ phía client (sigma cần `WebGL` và DOM, không chạy khi SSR); chưa thử trong TanStack Start, kiểm ở bước 9;
  - màu: đọc token Astryx bằng `getComputedStyle` rồi gán vào thuộc tính node / cạnh, gán lại khi đổi theme;
  - bàn phím: canvas không có; đường cho bàn phím và trình đọc màn hình là danh sách mệnh đề (A9). Chọn node trong danh sách thì hình graph chọn theo;
  - kiểm bằng mắt mũi tên và nhãn cạnh ở bước 9 (spike chỉ xác nhận cấu hình chạy không lỗi).
- **Hiện graph lớn cho đọc được:** mặc định hiện **lân cận 1–2 bước của mệnh đề đang chọn** (hoặc các mệnh đề của một chủ đề đang lọc), ẩn phần còn lại bằng trạng thái `hidden`. Chế độ "toàn bộ" chỉ để nhìn cụm: tô màu theo chủ đề, nhãn node chỉ hiện khi đủ chỗ hoặc khi hover / chọn, nhãn cạnh chỉ hiện trong lân cận. Vị trí bố cục là dữ liệu hiển thị, không ghi vào log kiến thức.

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

## Bước 3: hồ sơ dạy học v2, vai mới (2026-11-21)

**Hồ sơ v2 (`core`, `agent`):**

- `TeachingProfile` thêm `name` và `prompts.practitioner`, `prompts.extractor`, `prompts.auditor`, `prompts.merge`, đều tuỳ chọn. Schema của event không thêm giới hạn nào, nên log cũ không bao giờ bị từ chối vì giới hạn đặt sau.
- `ResolvedProfile` (core) là hồ sơ đã điền đủ mọi trường. `resolveProfile(profile)` (`@kd-learn/agent`, cả `@kd-learn/agent/client`) điền phần thiếu từ `defaultProfile`; `defaultProfile` giờ có kiểu `ResolvedProfile`. Bước 4 và 6 lấy prompt bằng `resolveProfile(profile).prompts.extractor` (và `auditor`, `merge`, `practitioner`).
- Prompt mặc định của extractor, auditor (mệnh đề và cạnh trong một lần gọi, cho tách mệnh đề hai ý) và merge (bản v2 theo ứng viên) lấy từ spike bước 1. Prompt practitioner là bản đầu; bước 6 chỉnh khi có schema của từng loại bài.
- `SavedProfile` (core): hồ sơ người dùng lưu, chặt hơn: id dạng slug tối đa 64 ký tự, `language` là thẻ BCP 47, N từ 1 tới 20, M từ 1 tới 50, mỗi prompt 1–20.000 ký tự, `name` tối đa 100.
- Fixture log phase 2 thật (`packages/core/src/fixtures/phase-2-session.ts`, buổi `bayes` của spike bước 1, hồ sơ chưa có trường mới) vẫn decode và dựng projection tới `Done` (`profile.test.ts`).

**Lưu hồ sơ (`storage`):**

- Port thêm `getProfile` (trả `TeachingProfile | undefined`, đọc bằng schema lỏng), `saveProfile(profile | undefined)` (undefined là về mặc định; driver kiểm `SavedProfile`, sai thì `StorageFailure`, hồ sơ cũ giữ nguyên) và thay đổi `ProfileChanged`. Bộ test port chạy trên memory và sqlite-node; sqlite-wasm kiểm bằng Playwright (`storage.e2e.ts`).
- Khách: migration v2 của danh sách khách, bảng `teaching_profile` (một hàng, `slot = 1`). Server: migration v6 của danh sách server, bảng `teaching_profiles` khoá `user_id`, chỉ đọc ghi qua `forUser` (không có khoá ngoại tới `users`, giống `sessions`). Test hai người dùng: không đọc, không thay, không xoá được hồ sơ của người kia.

**API và server:**

- `GET`, `PUT` (`ProfileRequest`), `DELETE /api/account/profile`, đều trả `ProfileResponse { profile, saved }` (`profile` đã điền mặc định). Thân `PUT` tối đa 512 KiB (`MAX_PROFILE_BODY_BYTES`; các route tài khoản khác vẫn 16 KiB), decode bằng `SavedProfile` và từ chối trường thừa. Client: `profile()`, `saveProfile()`, `resetProfile()` trong `account-client.ts`. Test: lưu / đọc / về mặc định, sai giới hạn bị từ chối (400, 413), cross-user, buổi mới chụp hồ sơ đã lưu.
- Server dùng `activeProfile(storage)` (`packages/server/src/profile.ts`) để lấy hồ sơ đang dùng; `Accounts` có thêm `storage` (`ServerStorage`). Buổi tài khoản mới chụp hồ sơ đang dùng; ngôn ngữ vẫn lấy theo request như trước.
- Khách: màn chính chụp hồ sơ đã lưu trong DB local vào `SessionCreated`. Demo luôn chụp hồ sơ mặc định, và server vẫn thay cả hồ sơ bằng của mình (`withServerProfile`, có test cho prompt của phase 3).

**Vai và model:**

- `ModelRole` / `RoleModels` (api) và `AgentRole` (core) thêm `practitioner`, `extractor`. `MessageAppended.agent` không đổi.
- `roleFallback` (`@kd-learn/api`): `practitioner` và `extractor` chưa đặt thì dùng vai `teacher`. `SettingsService.resolveModel(userId, role)` áp dụng sẵn; cả hai chưa đặt thì trả `RoleNotConfigured` với tên vai được hỏi, route luyện tập (bước 7) đổi thành `409 RoleNotConfigured` như route lượt. Job extraction (bước 5) cũng gọi `resolveModel(userId, 'extractor')`, gặp `RoleNotConfigured` thì không ghi `ExtractionStarted` (A3).
- Cài đặt tài khoản hiện thêm hai dòng vai, kèm dòng "chưa đặt thì dùng model của Teacher". Khách vẫn một model cho mọi vai, không đổi.

**Còn mở:**

- Không có màn sửa hồ sơ (bước 11). Chưa chặn id `default` cho hồ sơ đã lưu: bước 11 tự sinh id khi nhân bản.
- Số thứ tự migration (khách v2, server v6) có thể dời sau khi bước 2 vào `main` trước; xem số cuối cùng trong `packages/storage/src/sqlite/schema.ts` và `sqlite-node/schema.ts`.
