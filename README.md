# Phim Tổng Hợp

Trang xem phim tổng hợp từ 2 nguồn NC và KK. Web app được build bằng Vite + React, deploy lên Cloudflare Pages.

## Deploy lên Cloudflare Pages

### 1. Đẩy code lên GitHub

```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/<tai-khoan>/<ten-repo>.git
git push -u origin main
```

> File `.env` đã được gitignore — không đẩy lên GitHub. Repo chỉ chứa mã nguồn.

### 2. Kết nối Cloudflare Pages

1. Vào Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Chọn repository vừa đẩy lên, nhấn **Begin setup**.
3. Điền đúng các giá trị sau:

| Cài đặt | Giá trị |
| --- | --- |
| Production branch | `main` (đúng tên nhánh đã push lên GitHub) |
| Framework preset | `None` |
| Build command | `bun run build` |
| Build output directory | `dist` |
| Root directory | `web-phim-tong-hop` |

4. Nhấn **Save and Deploy**.

Cloudflare Pages sẽ tự cài dependency bằng Bun, chạy `bun run build` và publish thư mục `dist` mỗi khi bạn push lên nhánh `main`.

### Các file đã chuẩn bị sẵn trong repo

- `web-phim-tong-hop/bun.lockb` — file marker để Pages nhận diện project dùng Bun (Pages không hiểu `bun.lock` dạng text).
- `web-phim-tong-hop/bunfig.toml` — cấu hình bun.
- `.nvmrc` (gốc repo và trong app) + `web-phim-tong-hop/.node-version` — ghim Node 22 cho hệ thống build.
- `web-phim-tong-hop/public/_redirects` — fallback SPA để các link như `/phimtonghop/<slug>` mở trực tiếp không bị 404.
- `web-phim-tong-hop/public/_headers` — cache dài hạn cho asset, header bảo mật cơ bản.
- `web-phim-tong-hop/wrangler.toml` — khai báo thư mục build output (`dist`).

## Nếu deploy không chạy hoặc báo lỗi

Kiểm tra lần lượt:

1. **Đã push code lên GitHub chưa?** Vào repository trên GitHub xem có file `web-phim-tong-hop/package.json` không. Nếu repo rỗng, Pages không có gì để build.
2. **Production branch có đúng không?** Trong Pages → **Settings → Builds & deployments** → Production branch phải trùng tên nhánh bạn đã push (thường là `main`). Nếu nhánh là `master` mà Pages đang theo dõi `main`, sẽ không có build nào được kích hoạt.
3. **Root directory đã đặt là `web-phim-tong-hop` chưa?** Nếu để trống, Pages sẽ tìm `package.json` ở gốc repo và báo lỗi "package.json not found".
4. **Framework preset** phải là `None` (nếu chọn preset khác, Pages sẽ ghi đè build command của bạn).
5. **Xem log deploy**: vào trang project → mục **Deployments** → bấm vào deployment lỗi → **View build log**. Copy lỗi và dán để xử lý.
   - Nếu log báo `bun: command not found`: project đang dùng Build System cũ (v2). Vào **Settings → Builds & deployments → Build system version** chọn `Version 3`, hoặc thêm environment variable `NODE_VERSION = 22` rồi bấm **Retry deployment**.
   - Nếu log báo lỗi khi cài dependency: bấm **Retry deployment** một lần nữa (lỗi mạng tạm thời khá phổ biến).
6. **Retry deployment**: ở trang Deployments, bấm nút ba chấm trên deployment lỗi → **Retry deployment**.
