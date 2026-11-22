# 2. Quyết định đã chốt: sản phẩm


## 2.1 Sản phẩm

| Chủ đề | Quyết định |
| --- | --- |
| Mục đích | Dùng cá nhân trước, giữ repo sạch để mở mã nguồn sau. Giấy phép MIT |
| Người dùng | Nhóm nhỏ tin nhau, mỗi người dữ liệu riêng, một admin |
| Tính năng | Prober + Teacher, Practice, knowledge graph, side chat, PDF / import ghi chú, research web, hình minh hoạ + demo tương tác |
| Ngoài phạm vi | Dictation, hệ thống plugin, bản desktop, import dữ liệu từ LearnHarness |
| Ngôn ngữ | Giao diện i18n vi + en từ đầu. Ngôn ngữ dạy là cài đặt riêng. Code, tên, comment, prompt bằng tiếng Anh |
| UX (phase 7) | Mọi trang canh theo một khung giữa; điều hướng thanh trên có trạng thái đang chọn, tài khoản và ngôn ngữ trong một menu; side chat đóng mặc định; danh sách buổi học có trạng thái và tiến độ. Quy tắc ở `DESIGN.md` "UX", kiểm bằng skill `ux-check` ([cai-thien-ux.md](cai-thien-ux.md)) |
| Giao diện | Theo `DESIGN.md`, hiện thực bằng một theme Astryx riêng. Token ngữ nghĩa từ đầu. Dark mode và chọn theme dựng sẵn ở phase 6: mỗi theme có bộ màu light và dark, chế độ sáng / tối / theo hệ thống; khách lưu lựa chọn trên máy, tài khoản lưu trên server ([theme-va-dien-thoai.md](archive/theme-va-dien-thoai.md)) |

## 2.2 Ba chế độ chạy

| Chế độ | Đăng nhập | Dữ liệu | Key model |
| --- | --- | --- | --- |
| Khách | Không | DB local trên thiết bị | Người dùng tự nhập, gửi theo từng request, server không lưu |
| Tài khoản | Có | DB server | Lưu mã hoá trên server theo người dùng |
| Demo | Không | DB local trên thiết bị | Key của server, có hạn mức lượt gọi |

- Khách và tài khoản tách hẳn: không sync, không import giữa hai bên.
- Agent luôn chạy trên server ở cả ba chế độ. Với khách và demo, server không lưu key hay dữ liệu buổi học.
- Admin có ba công tắc: đăng ký (mở / theo lời mời / đóng), chế độ khách, chế độ demo.

## 2.3 Thiết kế mở

- **Model theo vai:** mỗi agent (Prober, Teacher, Practitioner, extractor) chọn provider và model riêng.
- **Hồ sơ dạy học:** prompt và tham số của agent là dữ liệu sửa được, không viết cứng trong code.
- **Loại bài tập:** registry trong code, thêm loại mới không phải sửa lõi.
- **Theme:** đổi qua design token, không sửa component. Về sau người dùng sẽ tự tạo, import / export theme và có marketplace theme (xem [mục 4](04-phases.md)). Vì vậy ngay từ phase 0:
  - Theme là dữ liệu thuần, có Effect Schema và số phiên bản, không chứa CSS hay JS.
  - Token phải đổi được lúc chạy (qua CSS variable), không chỉ lúc build.

