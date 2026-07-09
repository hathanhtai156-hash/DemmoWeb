# Deploy LogiPort Mart

## Render

1. Tao repository moi tren GitHub va upload cac file trong thu muc nay, tru `node_modules/` va `.env`.
2. Vao Render, chon **New Web Service** va ket noi repository.
3. Render se doc `render.yaml` tu dong.
4. Neu cau hinh thu cong:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment: `Node`
   - Env vars:
     - `JWT_SECRET`: mot chuoi bi mat bat ky
     - `SQLITE_DB_PATH`: `/tmp/database.sqlite`
     - `OPENAI_API_KEY`: API key trong OpenAI Platform
     - `OPENAI_MODEL`: `gpt-4o-mini`

## Local

```bash
npm install
npm start
```

Mo `http://localhost:4000`.

Tai khoan demo:

- Admin: `admin` / `admin123`
- Nhan vien: `nhanvien` / `nv123456`
- Khach hang: `khachhang` / `kh123456`


## Bản mở rộng công ty
Các trang chính:
- `index.html`: Trang chủ + danh mục sản phẩm + thông tin doanh nghiệp.
- `logistics.html`: Form yêu cầu logistics đầy đủ.
- `quote.html`: Báo giá vận chuyển demo.
- `orders.html`: Theo dõi trạng thái đơn hàng.
- `staff.html`: Quản lý sản phẩm, kho, đơn, đóng gói, vận chuyển.
- `admin.html`: Duyệt đơn, phân quyền, báo cáo công ty.
- `news.html`: Tin tức logistics.
- `contact.html`: Thông tin doanh nghiệp và liên hệ.

## Ghi chú reset sản phẩm demo
Bản này mặc định reset lại danh sách sản phẩm mẫu mỗi lần chạy server để tránh sản phẩm nhập thử bị sai ảnh/tên.
Nếu muốn giữ sản phẩm tự thêm sau này, tạo file `.env` và thêm dòng:

```env
RESET_PRODUCTS_ON_START=false
```

Nếu trình duyệt vẫn thấy sản phẩm cũ, hãy tắt server bằng `Ctrl + C`, chạy lại `npm.cmd start`, rồi nhấn `Ctrl + F5` trên trình duyệt.
