/**
 * Logo của trang — nút play trên nền gradient cam-đỏ, phong cách điện ảnh.
 * Dùng chung cho header trang chủ, thanh điều hướng chi tiết và favicon.
 */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Phim Tổng hợp"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="pt-logo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f43f5e" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#pt-logo-grad)" />
      {/* Rãnh phim nhỏ bên trái, gợi cuộn phim điện ảnh */}
      <rect x="8" y="16" width="3.5" height="6" rx="1.75" fill="#fff" opacity="0.55" />
      <rect x="8" y="29" width="3.5" height="6" rx="1.75" fill="#fff" opacity="0.55" />
      <rect x="8" y="42" width="3.5" height="6" rx="1.75" fill="#fff" opacity="0.55" />
      <path
        d="M26.5 20.5a3.2 3.2 0 0 1 4.9-2.66l16.8 11.5a3.2 3.2 0 0 1 0 5.32l-16.8 11.5a3.2 3.2 0 0 1-4.9-2.66V20.5z"
        fill="#fff"
      />
    </svg>
  );
}
