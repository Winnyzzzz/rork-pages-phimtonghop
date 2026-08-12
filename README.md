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
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `bun run build` |
| Build output directory | `dist` |
| Root directory | `web-phim-tong-hop` |

4. Vào mục **Environment variables** (Production), thêm:

| Tên | Giá trị |
| --- | --- |
| `BUN_VERSION` | `1.3.9` |

5. Nhấn **Save and Deploy**.

Cloudflare Pages sẽ tự cài dependency bằng Bun, chạy `bun run build` và publish thư mục `dist` mỗi khi bạn push lên nhánh `main`.

### Các file đã chuẩn bị sẵn trong repo

- `web-phim-tong-hop/public/_redirects` — fallback SPA để các link như `/phimtonghop/<slug>` mở trực tiếp không bị 404.
- `web-phim-tong-hop/public/_headers` — cache dài hạn cho asset, header bảo mật cơ bản.
- `web-phim-tong-hop/.node-version` — ghim Node 22 cho hệ thống build.
- `web-phim-tong-hop/wrangler.toml` — khai báo thư mục build output (`dist`).
