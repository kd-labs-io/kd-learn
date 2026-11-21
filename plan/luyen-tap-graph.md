# Plan phần chính phase 3: practice + graph

- **Ngày lập:** 2026-11-21
- **Phạm vi:** phase 3 ([mục 4](04-phases.md)): Practitioner, registry loại bài tập, extractor / auditor / merge, màn hình graph (spike TanStack Charts), hồ sơ dạy học sửa được
- **Xong khi:** graph tự cập nhật sau buổi học, luyện tập lấy bài từ graph
- **Trạng thái:** đang làm, tiến độ ở [progress/phase-3.md](progress/phase-3.md)
- **Nền đã có:** event log append-only và projection trong `core` ([mục 3.5](03-kien-truc.md)), port AI ([mục 3.3](03-kien-truc.md)), hai chế độ lưu (khách: DB local, server không trạng thái; tài khoản: SQLite server, lượt chạy tách khỏi request, [archive/tai-khoan.md](archive/tai-khoan.md) A1–A3), model theo vai cho tài khoản (A6 phase 2), demo có ngân sách chung (A8 phase 2)

Ba quyết định sản phẩm chốt ngày 2026-11-21: một graph cho mỗi người (A1), demo dùng được graph và luyện tập, tính chung ngân sách (A8), làm đủ bốn loại bài tập đầu tiên (A6).

## A. Quyết định nền

### A1. Một log kiến thức cho mỗi người

- **Một graph cho mỗi người (chốt 2026-11-21)**, gộp mọi buổi học và mọi chủ đề. Mệnh đề trùng giữa các chủ đề được merge, cạnh nối được giữa hai chủ đề. Màn graph lọc theo chủ đề và theo buổi.
- Graph và kết quả luyện tập nằm trong **một log kiến thức** (knowledge log) của người dùng: append-only, có `seq`, event là JSON thuần, projection thuần trong `core`. Giống event log của buổi học, chỉ khác khoá: theo chủ sở hữu, không theo buổi.
- **Bảng riêng**, không dùng chung `events`: `knowledge_events (owner, seq, id, tag, at, payload)`, khoá `(owner, seq)`, cùng trigger chặn sửa / xoá. DDL đặt cạnh `eventsTable` trong `packages/storage/src/sqlite/schema.ts`.
  - Khách: migration v3 của danh sách khách (v2 là hồ sơ, bước 3), `owner` là hằng số (DB local chỉ có một người).
  - Server: migration v7 trong danh sách riêng của server, `owner` là `user_id`.
- Port `storage` thêm `appendKnowledge(events, { expectedLastSeq })` (một lô, nguyên tử; `expectedLastSeq` bắt buộc, log đã đi tiếp thì `KnowledgeConflict`, không ghi gì; mọi chỗ ghi dùng `appendKnowledgeChecked`), `readKnowledge` và thay đổi `KnowledgeChanged` trong `StorageChange`. Driver server cấp qua `forUser(userId)`, lọc bên trong driver như A3 phase 2 ([rủi ro 26](05-rui-ro.md)). Không có hàm nào nhận `owner` từ bên ngoài.
- **Event của graph:** `PropositionAdded`, `PropositionSourced` (thêm nguồn cho mệnh đề đã có, thêm ở bước 2), `PropositionRevised`, `PropositionsMerged` (gộp hai mệnh đề đã có), `PropositionRetired` (người học bỏ một mệnh đề sai), `EdgeAdded`, `EdgeRemoved`, cộng các event của extraction (`ExtractionStarted`, `SessionExtracted`, `ExtractionFailed`, A3) và luyện tập (A7).
  - **Mệnh đề:** câu tự đứng được một mình (không "nó", "như trên"), kèm nguồn (`sessionId`, `stepId` nếu có) và chủ đề.
  - **Cạnh:** có hướng, kèm nhãn chữ. Quan hệ thuộc tập đóng `requires`, `implies`, `supports`, `exampleOf`, `contrastsWith` (chốt ở bước 1), đọc theo câu "from RELATION to". Cấm chu trình trên `requires` và `implies`, đọc về cùng chiều "trước → sau" (`A implies B`: A trước; `A requires B`: B trước); chuỗi lập luận là đường đi theo hai quan hệ này. `contrastsWith` không có hướng: hai chiều là một cạnh.
  - Projection chặt như log buổi học: event tham chiếu mệnh đề không có, hay cạnh tạo chu trình trên quan hệ có thứ tự, thì trả `ProjectionError`; client chạy projection trước mỗi lần ghi và bỏ lô không hợp lệ.

### A2. Hồ sơ dạy học sửa được

- Hồ sơ vẫn là dữ liệu có schema (`TeachingProfile` trong `core`). Thêm prompt cho Practitioner (ra bài và chấm), extractor, auditor, merge.
- **Tương thích log cũ:** mọi `SessionCreated` đã ghi chụp hồ sơ cũ. Quy tắc: **trường mới của hồ sơ luôn là tuỳ chọn**; thiếu thì lấy giá trị của hồ sơ mặc định trong code. Không bao giờ đổi trường đã có thành bắt buộc hay đổi nghĩa. Test: log phase 1–2 (fixture) vẫn dựng projection được.
- **Hồ sơ mặc định** nằm trong code (`agent`), chỉ đọc. Người dùng nhân bản rồi sửa bản sao; có nút "về mặc định". Một hồ sơ đang dùng cho mỗi người.
- **Lưu:** khách ở bảng mới trong DB local (migration v2 của khách), tài khoản ở bảng của server theo `user_id`. Validate bằng Effect Schema cả ở client và server; giới hạn độ dài prompt.
- **Lúc nào dùng hồ sơ nào:** buổi học mới chụp hồ sơ đang dùng vào `SessionCreated` (như phase 1). Extraction và luyện tập dùng hồ sơ đang dùng lúc chạy; event kết quả ghi `profileId` để tra lại.
- **Demo:** server luôn thay hồ sơ bằng hồ sơ của mình ([rủi ro 29](05-rui-ro.md)), kể cả cho extraction và luyện tập. Demo không có màn sửa hồ sơ.

### A3. Extraction: extractor → auditor → merge

- Ba bước, mỗi bước một lần gọi model với output có cấu trúc (Effect Schema):
  1. **Extractor:** đọc bản ghi buổi học (plan, đánh giá, các lượt đã `TurnCompleted`), đề xuất mệnh đề và cạnh mới.
  2. **Auditor:** kiểm từng đề xuất với bản ghi: đúng không, có thật được dạy hay người học thể hiện không, có tự đứng được không. Bỏ hoặc sửa câu.
  3. **Merge:** so đề xuất còn lại với các mệnh đề đã có gần nhất (A4): trùng thì gộp vào mệnh đề cũ (thêm nguồn, có thể `PropositionRevised`), mới thì thêm, kèm cạnh tới mệnh đề cũ.
- **Chốt ở bước 1 (2026-11-21):** ba lần gọi riêng. Auditor kiểm cả mệnh đề lẫn cạnh trong một lần gọi (đảo chiều, đổi quan hệ, bỏ cạnh lặp) và được tách một mệnh đề hai ý thành hai. Merge nhận mỗi mệnh đề mới kèm danh sách ứng viên của nó (A4), không nhận cả lát chung. Kết quả đo ở [progress/phase-3.md](progress/phase-3.md) bước 1.
- **Chạy khi nào:** sau `SessionCompleted`. Buổi chưa xong không tự trích; người học bấm "trích ngay" được (cắt được nếu quá lớn).
- **Idempotent theo buổi:** toàn bộ kết quả một lần trích ghi trong **một lô** của log kiến thức, kết thúc bằng `SessionExtracted {sessionId, extractionId, profileId}`. Projection từ chối `SessionExtracted` thứ hai cho cùng buổi (cả lô bị bỏ). Hai tab hay hai request cùng trích một buổi thì lô sau bị từ chối, không có mệnh đề trùng.
- **Ghi lần thử trước khi gọi model**, như `TurnStarted`: `ExtractionStarted {sessionId, extractionId}` vào log kiến thức. Lần thử có `ExtractionStarted` mà chưa có `SessionExtracted` hay `ExtractionFailed` (và không còn chạy) là "bị ngắt". Lỗi ghi `ExtractionFailed {sessionId, extractionId, code, retryable}`.
- **Không tự chạy lại sau lỗi hay bị ngắt:** chỉ tự chạy khi buổi đã `SessionCompleted` **và chưa có `ExtractionStarted` nào**. Sau lỗi hay bị ngắt chỉ có nút thử lại (giống quy tắc của lượt, [mục 3.5](03-kien-truc.md)). Vậy mỗi buổi tự trích tối đa một lần.
- **Buổi xong trước phase 3:** không tự trích ở cả hai chế độ (tự trích chỉ do sự kiện "buổi vừa xong" kích hoạt, không quét lại log cũ). Màn graph liệt kê các buổi đã xong mà chưa trích, kèm nút trích từng buổi.
- **Điểm kích hoạt:** `SessionCompleted` có hai đường ghi: lô của lượt (tool `complete_step` ở bước cuối) và lô bỏ bước cuối (`StepSkipped`, không có lượt). Server: cả hai nằm trong `packages/server/src/sessions/runner.ts`; móc vào chỗ ghi lô, không vào từng đường. Khách: cả hai nằm trong runner của client (`apps/web/src/learn/runner.ts`).
- **Tài khoản:** server tự khởi chạy extraction ngay sau khi ghi lô có `SessionCompleted`, trong fiber tách khỏi request, như lượt. Đóng tab vẫn chạy.
  - Một extraction chạy cùng lúc cho mỗi người (log kiến thức là chung). Buổi khác xong giữa chừng thì **xếp hàng**, không lỗi.
  - Vai `extractor` chưa đặt model thì dùng model của `teacher`; cả hai chưa đặt thì không ghi `ExtractionStarted` (không tính là lần thử), màn graph báo cần đặt model và có nút trích.
  - Server khởi động lại giữa chừng thì lần thử thành "bị ngắt" (lúc khởi động ghi `ExtractionFailed {code: 'Interrupted', retryable: true}`), không tự chạy lại. Job sống sót khi khởi động lại thuộc phase 4.
- **Khách và demo:** client ghi `ExtractionStarted` rồi gọi `POST /api/knowledge/extract` (server không trạng thái). Server trả lô event qua SSE như `/api/turns`; client ghi lô trong một transaction. Đóng tab giữa chừng thì lần thử thành "bị ngắt", như lượt. Web Lock `kd-learn:knowledge` để hai tab không cùng trích.
- **Chốt ở bước 5 (2026-11-21):** tài khoản ghi `ExtractionStarted` ngay lúc xếp hàng, nên buổi đang chờ cũng là một lần thử (khởi động lại thì thành `Interrupted`). Khách lấy Web Lock có chờ (các buổi xếp hàng, không bị từ chối); người giữ lock đóng các lần thử còn mở thành `Interrupted` trước khi bắt đầu. Stream đứt thì client ghi `ExtractionFailed {code: 'Network'}` thay vì để mở.
- **Kiểm lại lúc ghi:** trong lúc trích, log kiến thức có thể đã có event mới (luyện tập, bỏ mệnh đề, buổi khác). Lô kết quả được chạy projection trên log **hiện tại** trước khi ghi; không hợp lệ (ví dụ gộp vào mệnh đề vừa bị bỏ) thì ghi `ExtractionFailed {code: 'Conflict', retryable: true}`.

### A4. Lát graph gửi theo request

- Graph vài nghìn mệnh đề không vừa giới hạn request (1 MiB khách, 256 KiB demo). Merge chỉ cần các mệnh đề **gần** với nội dung buổi học.
- Chọn hai tầng, cả hai là hàm thuần trong `core`, đo "gần" theo từ vựng (tập từ bỏ stopword, cosine nhị phân; không embedding):
  1. **Lát của buổi:** tối đa 200 mệnh đề gần nhất với nội dung buổi (chủ đề, tên và mục tiêu các bước, đánh giá), cắt theo số byte.
  2. **Ứng viên:** sau auditor, mỗi mệnh đề mới lấy K = 5 mệnh đề gần nhất trong lát; merge chỉ thấy các ứng viên này (chốt ở bước 1: gửi cả lát chung thì merge không ổn định và bỏ sót mệnh đề trùng).
- Khách và demo: **client** chạy tầng 1 trên log kiến thức local và gửi lát kèm log buổi học; server chạy tầng 2. Tài khoản: server chạy cả hai tầng trên DB. Hai chế độ dùng cùng code, nên kết quả merge chỉ khác do dữ liệu.
- Embedding cần port mới và có thể cần provider khác: ngoài phạm vi phase 3 (D), trừ khi spike C2 cho thấy chọn theo từ vựng bỏ sót quá nhiều.
- Server kiểm lát nhận được như mọi dữ liệu từ client: decode bằng schema, id mệnh đề trong kết quả merge phải thuộc lát đã gửi.

### A5. Vai và model

- Thêm hai vai vào `ModelRole` / `RoleModels` (`packages/api/src/contract.ts`) và `AgentRole` (`core`): **`practitioner`** (ra bài, chấm bài) và **`extractor`** (cả ba bước extractor, auditor, merge dùng chung model của vai này). Cài đặt tài khoản (`AccountSettings.tsx`) hiện thêm hai dòng.
- Tài khoản có từ phase 2 chưa đặt hai vai này. Vai mới chưa đặt thì **dùng model của `teacher`**; route do người dùng gọi (luyện tập) mà cả hai chưa đặt thì trả `409 RoleNotConfigured` như phase 2. Job extraction không có người gọi nên xử lý riêng (A3).
- Prompt của auditor và merge vẫn là prompt riêng trong hồ sơ (A2), chỉ dùng chung model.
- Khách giữ một model cho mọi vai (A6 phase 2). `MessageAppended.agent` không đổi: luyện tập không ghi `MessageAppended` (A7).
- ACP: hai vai mới chọn model trong danh sách admin cho phép, như mọi vai ([rủi ro 30](05-rui-ro.md)).

### A6. Registry loại bài tập

- Mỗi loại bài tập là một module đăng ký vào registry trong `core`: `id`, schema nội dung bài (Practitioner sinh ra), schema câu trả lời, cách chấm (`deterministic` chạy trong `core`, hay `model` gọi Practitioner), điều kiện chọn được (ví dụ cần một chuỗi ít nhất 3 mệnh đề nối nhau). Thêm loại mới chỉ thêm module và renderer, không sửa lõi.
- UI có registry renderer song song trong `apps/web` (khoá theo `id` của loại). Loại không có renderer thì không được chọn.
- **Bốn loại đầu tiên (chốt 2026-11-21):**

| Loại | Lấy từ graph | Chấm |
| --- | --- | --- |
| Trắc nghiệm | Một mệnh đề; phương án nhiễu từ mệnh đề lân cận hoặc do model sinh | Code |
| Trả lời ngắn | Một mệnh đề | Model, theo mệnh đề làm đáp án |
| Giải thích lập luận | Một cạnh hoặc đường đi ngắn A → B | Model, theo các mệnh đề và cạnh trên đường đi |
| Sắp xếp chuỗi lập luận | Một chuỗi 3–6 mệnh đề nối theo cạnh có thứ tự | Code: chấp nhận mọi thứ tự topo hợp lệ của chuỗi, không chỉ một đáp án |

- Chấm bằng model trả điểm trên thang cố định kèm nhận xét ngắn; output có cấu trúc. **Chốt ở bước 6:** ba mức `correct` / `partial` / `incorrect` (1 / 0,5 / 0); bài sắp xếp được dựng bằng code (không gọi model) và chấm bằng tỉ lệ ràng buộc thứ tự được giữ; bài tự đủ (mang đáp án và tham chiếu) để chấm được sau khi graph đổi. Câu trả lời của người học là dữ liệu không tin cậy trong prompt chấm (C4).
- **Đáp án:** với tài khoản, đáp án chỉ nằm trên server cho tới khi chấm xong (API ra bài không trả đáp án). Với khách, đáp án nằm trong log local của chính người đó: chấp nhận được, đây là dữ liệu của họ.

### A7. Luyện tập là một buổi riêng trên log kiến thức

- Luyện tập không phải trạng thái của buổi học: nó đọc graph chung của mọi buổi. Một **lượt luyện tập** là một bộ vài bài; event ghi thẳng vào log kiến thức: `PracticeStarted {practiceId}`, `ExerciseIssued {exerciseId, type, propositionIds, content}`, `AnswerSubmitted`, `ExerciseGraded {score, feedback, profileId}`, `PracticeEnded`. Không có hội thoại nhiều lượt: ra bài → trả lời → chấm.
- Một log duy nhất nên kết quả chấm và mức nắm vững cập nhật nguyên tử, không phải đồng bộ hai nơi.
- **Mức nắm vững** là projection thuần trong `core` từ các `ExerciseGraded`: điểm và hạn ôn của từng mệnh đề (lặp lại ngắt quãng đơn giản, ví dụ hộp Leitner; chốt công thức ở bước 6). **Chốt ở bước 6:** hộp 1–5, hạn ôn 1 / 3 / 7 / 16 / 35 ngày; đúng (≥ 0,75) lên một hộp, một phần giữ hộp, sai (< 0,5) về hộp 1; điểm tính cho mệnh đề tại lúc chấm (qua chuỗi gộp, bỏ mệnh đề đã bỏ).
- **Chọn bài:** hàm thuần trong `core` chọn mệnh đề đến hạn hoặc yếu nhất, rồi chọn loại bài thoả điều kiện của registry. Practitioner chỉ viết nội dung bài cho mệnh đề đã chọn (tool / output có cấu trúc theo schema của loại), không tự chọn mệnh đề. Chốt ở bước 6: đến hạn, rồi chưa chấm bao giờ, rồi yếu nhất; loại bài xoay vòng trong các loại được phép; một lần gọi viết cả bộ bài.
- **Khách và demo:** `POST /api/practice/issue` và `POST /api/practice/grade` không trạng thái, client gửi lát cần thiết (mệnh đề đã chọn và lân cận), ghi lô trả về. Loại chấm bằng code thì client chấm local, không gọi server. **Tài khoản:** route dưới `/api/account/practice/*`, server ghi log; bài đang mở nằm trong log nên mở lại tab vẫn làm tiếp được.

### A8. Demo

- **Demo dùng được graph và luyện tập (chốt 2026-11-21)**, tính chung ngân sách demo (A8 phase 2): extraction tốn 3 lần gọi (bước 1), ra bài một lần, chấm bằng model một lần, chấm bằng code không tốn.
- Giữ chỗ trước khi gọi, quyết toán cuối, trần token mỗi lần gọi như phase 2. Trần 2.048 token ra không đủ cho extraction (đo được tới 4,4k, phần lớn là thinking): vai `extractor` có trần riêng, làm ở bước 5. Bước 4 đo với buổi tiếng Việt: auditor vượt 8.192 token ra khi còn chép lại câu cho mệnh đề giữ nguyên; sau khi rút gọn output thì chạy được với trần 16.384. Trần của vai `extractor`: 16.384 (làm ở bước 5). Extraction giữ chỗ 3 lần gọi; còn ít hơn 3 thì từ chối ngay, không gọi provider. Thân request của các route mới tối đa 256 KiB với demo. Server dùng hồ sơ của mình (A2).

### A9. Màn hình graph

- Hai phần: **danh sách** mệnh đề (tìm kiếm, lọc theo chủ đề / buổi, chi tiết mệnh đề: nguồn, cạnh vào / ra, mức nắm vững, nút bỏ mệnh đề) và **hình graph** (node và cạnh, kéo / chọn node).
- Danh sách đủ để thấy "graph tự cập nhật"; hình graph nằm ngoài đường tiêu chí xong, nên **cắt trước** nếu thư viện không đạt.
- Thư viện cho hình graph chốt ở spike (C1): TanStack Charts nếu đạt, không thì thư viện graph chuyên dụng. Nạp lười, chỉ chạy phía client. Màu lấy từ token Astryx qua `var(--...)`.
- Cùng mẫu với màn học: một interface nguồn dữ liệu (`KnowledgeSource`), hai cài đặt (khách đọc DB local và nghe `KnowledgeChanged`; tài khoản dùng TanStack Query, làm mới khi extraction xong). Live query của TanStack DB: chỉ dùng nếu C3 cho thấy cần.
- **Chốt ở bước 9 (2026-11-21):** danh sách không dùng TanStack Virtual: hiện 100 dòng mỗi lần và nút "Xem thêm" (danh sách ảo với Astryx phải tự đo dòng và đặt vị trí qua `xstyle` động; chưa đáng khi graph thật còn nhỏ). Xét lại khi graph thật có vài nghìn mệnh đề. Hình graph: sigma 4 theo C1 ([progress/phase-3.md](progress/phase-3.md) bước 9).

## B. Các bước

Mỗi bước có tiêu chí xong chạy được trong CI. Bước gọi model test bằng `AiPort` giả; kiểm bằng model thật tối đa một lần mỗi bước (Haiku `claude-haiku-5-5`, xem chi phí trước). Mọi route mới có test cross-user ([rủi ro 26](05-rui-ro.md)) và test key không lộ ở đường khách ([rủi ro 19](05-rui-ro.md)).

| # | Bước | Package | Xong khi |
| --- | --- | --- | --- |
| 0 | Spike hình graph (C1) | spike | Trả lời đủ C1; chốt thư viện, ghi vào [mục 2.5](02-ky-thuat.md) |
| 1 | Spike extraction với Haiku (C2, C3) | spike | Trả lời đủ C2, C3; chốt pipeline (số lần gọi), tập quan hệ của cạnh, cách chọn lát và K; đo token mỗi buổi |
| 2 | Log kiến thức: schema event, projection graph, chặn trích hai lần, hàm chọn lát (A1, A3, A4); bảng `knowledge_events` ở cả hai driver, port, `forUser` | core, storage | Test projection (event sai thứ tự, chu trình, `SessionExtracted` trùng); bộ test port chạy trên cả hai driver; test hai người dùng: không đọc, không ghi được log kiến thức của người kia |
| 3 | Hồ sơ dạy học v2 và vai mới: trường mới tuỳ chọn, lưu hồ sơ ở hai chế độ, API hồ sơ tài khoản, `practitioner` / `extractor` trong contract và cài đặt (A2, A5) | core, agent, storage, server, api, web | Log phase 1–2 (fixture) vẫn dựng được; hồ sơ sai schema bị từ chối ở client và server; demo luôn dùng hồ sơ của server; vai mới chưa đặt model thì dùng model của `teacher`, cả hai chưa đặt thì luyện tập trả `RoleNotConfigured` |
| 4 | Pipeline extraction trong `agent` (A3) | agent | Với `AiPort` giả: buổi → một lô event hợp lệ; merge chỉ tham chiếu id trong lát; trích lại cùng buổi không sinh mệnh đề trùng; output sai schema thành lỗi có kiểu |
| 5 | Extraction trên server: route khách / demo không trạng thái, job tài khoản sau `SessionCompleted` (cả đường bỏ bước cuối), hàng đợi theo người dùng, `Interrupted` khi khởi động lại, thử lại; client khách tự chạy đúng một lần (A3, A8) | server, api, web | Test: đóng kết nối, job tài khoản vẫn xong và event có trong DB; buổi xong bằng bỏ bước cuối cũng được trích; hai buổi xong cùng lúc thì chạy lần lượt; lỗi hay bị ngắt không tự chạy lại; buổi xong trước phase 3 không tự trích; demo trừ ngân sách đúng số lần gọi, hết ngân sách thì không gọi provider |
| 6 | Registry loại bài tập, bốn loại, sự kiện luyện tập trong log kiến thức và projection mức nắm vững (dời từ bước 2), hàm chọn bài, công thức nắm vững, Practitioner (A6, A7) | core, agent | Mỗi loại: schema, điều kiện chọn, chấm; sắp xếp chấp nhận mọi thứ tự topo; chọn bài ưu tiên mệnh đề đến hạn / yếu; Practitioner với `AiPort` giả ra bài đúng schema của loại |
| 7 | Luyện tập trên server: route khách / demo và tài khoản, chấm local cho loại chấm bằng code (A7, A8) | server, api | Test hợp đồng; bài đang mở còn sau khi đóng kết nối (tài khoản); cross-user; demo tính đúng ngân sách |
| 8 | Model giả cho e2e trả tool call và output có cấu trúc (`apps/web/e2e/fake-openai.ts`) | web | Test Playwright hiện có vẫn xanh; một test mẫu gọi route trích của khách bằng model giả và nhận lô event hợp lệ |
| 9 | Màn graph: `KnowledgeSource` hai cài đặt, danh sách, chi tiết, bỏ mệnh đề, hình graph theo C1, chuỗi vi/en (A9) | web, ui, i18n | Playwright ở cả hai chế độ: học xong một buổi (model giả), mở màn graph thấy mệnh đề mới mà không phải bấm gì |
| 10 | Màn luyện tập: registry renderer, bốn loại, nhận xét, mức nắm vững, chuỗi vi/en | web, ui, i18n | Playwright ở cả hai chế độ: luyện một bộ bài lấy từ graph, mức nắm vững đổi sau khi chấm; tải lại giữa bộ bài không mất bài |
| 11 | Màn sửa hồ sơ dạy học (TanStack Form, schema từ Effect Schema) | web, i18n | Playwright: nhân bản hồ sơ mặc định, sửa prompt, buổi mới chụp hồ sơ đã sửa; giá trị sai bị chặn |
| 12 | Kiểm tiêu chí phase bằng model thật | — | Đạt cả hai tiêu chí ở cả hai chế độ; đóng phase 3 theo quy ước ở `README.md` |

**Thứ tự:**

- Bước 0 và 1 trước tiên, làm song song được. Đường tiêu chí xong (2 → 4 → 5 → 6 → 7 → 9 phần danh sách → 10) không chờ kết quả bước 0; chỉ phần hình graph của bước 9 cần bước 0.
- Bước 2 cần bước 1 (tập quan hệ, cách chọn lát). Bước 3 làm song song với bước 2.
- Bước 4 cần bước 2 và 3. Bước 5 cần bước 4. Bước 6 cần bước 2 và 3. Bước 7 cần bước 6.
- Bước 8 cần bước 5, và trước bước 9. Bước 9 cần bước 5 và 8. Bước 10 cần bước 7 và 8. Bước 11 cần bước 3. Bước 12 cuối cùng.
- **Cắt giảm nếu quá lớn:** hình graph (phần của bước 9) cắt trước, rồi màn sửa hồ sơ (bước 11; hồ sơ vẫn là dữ liệu, chỉ thiếu UI), rồi "trích ngay" cho buổi chưa xong. Không cắt loại bài tập nào trong bốn loại đã chốt mà không hỏi lại.

## C. Câu hỏi cho spike

Không viết sẵn kết luận từ trí nhớ ([rủi ro 9](05-rui-ro.md)). Đọc tài liệu hiện hành rồi trả lời bằng thử nghiệm.

**C1. Hình graph (bước 0):**

- TanStack Charts hiện có kiểu graph mạng (node, cạnh) không, hay chỉ biểu đồ trục? Trạng thái phát hành và phiên bản?
- Nếu có: kéo node, chọn node (chuột, chạm, bàn phím), cạnh có hướng (mũi tên) và có nhãn, bố cục tự động (force hoặc phân tầng)?
- Vài nghìn node, vài nghìn cạnh: thời gian dựng bố cục, khung hình khi kéo, bộ nhớ, trên máy tính và trên điện thoại tầm trung (giả lập CPU chậm của Chromium)?
- Nếu không đạt: so vài thư viện graph chuyên dụng theo cùng tiêu chí, cộng: giấy phép (phải hợp MIT), kích thước bundle, render (SVG, canvas, WebGL), chạy được khi nạp lười chỉ phía client trong TanStack Start, đổi màu theo token lúc chạy.
- Hiện graph lớn thế nào cho đọc được: chỉ hiện lân cận của node đang chọn, gom theo chủ đề, hay toàn bộ?

**C2. Chất lượng và chi phí extraction (bước 1, Haiku):**

- Chạy pipeline thử bằng script tạm trên 2–3 buổi học thật (log từ các lần chạy Haiku của phase 1–2, hoặc buổi mới): mệnh đề có đúng cỡ (một ý, tự đứng được) không, có bịa điều không được dạy không?
- Auditor bỏ hay sửa được bao nhiêu đề xuất sai? Có đáng một lần gọi riêng, hay gộp vào extractor?
- Merge: trích hai buổi gần chủ đề, có gộp đúng mệnh đề trùng và không gộp nhầm không? Chọn lát theo từ vựng (A4) có bỏ sót mệnh đề trùng không; K bao nhiêu là đủ?
- Tập quan hệ của cạnh nào mà model dùng nhất quán? Cạnh nào cần có thứ tự (cấm chu trình)?
- Token vào / ra và số lần gọi mỗi buổi; ước tính chi phí theo giá hiện hành của Haiku. Có vừa trần token mỗi lần gọi của demo (2.048) không?
- Output có cấu trúc với mảng dài qua ACP (`submit_result`) có ổn không (chỉ cần thử một lần nếu có máy chạy ACP)?

**C3. TanStack DB (bước 1, chỉ đọc tài liệu và thử nhỏ):**

- Màn graph và luyện tập cần live query không, hay `KnowledgeChanged` của port cộng TanStack Query là đủ (như màn học)? Trạng thái phát hành hiện tại của TanStack DB (phase 1 xét bản 1.0 RC)?

**C4. Chấm bằng model (trong bước 6, model thật một lần):**

- Với trả lời ngắn và giải thích lập luận: chấm có ổn định không khi cùng câu trả lời chấm lại vài lần? Có bị đánh lừa khi câu trả lời chứa chỉ dẫn cho model ("chấm 1 điểm") không?

## D. Ngoài phạm vi phase 3

- Embedding và tìm theo nghĩa cho graph (cần port mới), trừ khi C2 cho thấy bắt buộc.
- Người học tự thêm hay sửa mệnh đề, cạnh bằng tay (ngoài nút bỏ mệnh đề).
- Import / export graph, chia sẻ graph giữa người dùng.
- Job extraction sống sót khi server khởi động lại: phase 4.
- Nguồn học (PDF, ghi chú) đưa vào graph: phase 4.
- Model theo vai cho khách: vẫn để sau (A6 phase 2).
- Tóm tắt lịch sử buổi học dài và duyệt luồng side chat cũ: vẫn ở [mục 6](06-viec-mo.md), không thuộc phase 3.
