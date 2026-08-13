import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MapPin, SlidersHorizontal, Tags, X } from "lucide-react";

import {
  getHubFilters,
  getHubList,
  type FilterOption,
  type HubFeedSource,
  type HubItem,
  type HubSource,
} from "@/lib/hub";
import { readListPosition, saveListPosition } from "@/lib/watch-memory";

const TABS: { key: HubFeedSource; label: string; color: string }[] = [
  { key: "all", label: "Tất cả nguồn", color: "bg-slate-900" },
  { key: "nguonc", label: "NC", color: "bg-emerald-500" },
  { key: "kk", label: "KK", color: "bg-sky-500" },
];

const SOURCE_LABEL: Record<HubSource, string> = {
  nguonc: "NC",
  kk: "KK",
};

const CURRENT_YEAR = new Date().getFullYear();
const YEARS: string[] = Array.from({ length: 26 }, (_, i) => String(CURRENT_YEAR - i));
const SOURCES: HubSource[] = ["nguonc", "kk"];
const FILTER_FIELDS = ["category", "country", "year"] as const;

type SearchState = {
  source: HubFeedSource;
  page: number;
  q: string;
  category: string;
  country: string;
  year: string;
};

function parseSearch(params: URLSearchParams): SearchState {
  const rawSource = params.get("source");
  const source: HubFeedSource =
    rawSource === "all" || (rawSource !== null && SOURCES.includes(rawSource as HubSource))
      ? (rawSource as HubFeedSource)
      : "all";
  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isFinite(rawPage) ? Math.min(500, Math.max(1, Math.trunc(rawPage))) : 1;
  return {
    source,
    page,
    q: params.get("q") ?? "",
    category: params.get("category") ?? "",
    country: params.get("country") ?? "",
    year: params.get("year") ?? "",
  };
}

export default function PhimTongHop() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { source, page, q, category, country, year } = parseSearch(params);
  const [qInput, setQInput] = useState<string>(q);
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  const scope = `hub:${source}:${page}:${q}:${category}:${country}:${year}`;
  const restoredRef = useRef<boolean>(false);

  const { data: filters, isLoading: isLoadingFilters } = useQuery({
    queryKey: ["hub-filters"],
    queryFn: () => getHubFilters(),
    staleTime: 24 * 60 * 60_000,
  });
  const categories = filters?.categories ?? [];
  const countries = filters?.countries ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ["hub-list", source, page, q, category, country, year],
    queryFn: () => getHubList({ source, page, q, category, country, year }),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  const items: HubItem[] = data?.items ?? [];
  const maxPage = data?.maxPage ?? 1;
  const hasFilter = !!(category || country || year);
  const activeFilterCount = [category, country, year].filter(Boolean).length;

  const goto = useCallback(
    (patch: Partial<SearchState>): void => {
      const next: SearchState = { source, page, q, category, country, year, ...patch };
      setParams({
        source: next.source,
        page: String(next.page),
        q: next.q,
        category: next.category,
        country: next.country,
        year: next.year,
      });
    },
    [source, page, q, category, country, year, setParams],
  );

  const selectedCategory = categories.find((option) => option.slug === category);
  const selectedCountry = countries.find((option) => option.slug === country);

  const applyFilters = useCallback(
    (patch: Partial<SearchState>): void => {
      const nextSource = patch.source ?? source;
      const requestedFilters: Pick<SearchState, (typeof FILTER_FIELDS)[number]> = {
        category: patch.category ?? category,
        country: patch.country ?? country,
        year: patch.year ?? year,
      };
      const explicitlySelected = FILTER_FIELDS.find((field) => patch[field] !== undefined && patch[field] !== "");
      const activeField = explicitlySelected ?? FILTER_FIELDS.find((field) => requestedFilters[field] !== "");
      const exclusiveNguoncFilters: Partial<SearchState> =
        nextSource === "nguonc"
          ? {
              category: activeField === "category" ? requestedFilters.category : "",
              country: activeField === "country" ? requestedFilters.country : "",
              year: activeField === "year" ? requestedFilters.year : "",
            }
          : {};

      window.scrollTo({ top: 0, behavior: "smooth" });
      goto({ page: 1, ...patch, ...exclusiveNguoncFilters });
    },
    [category, country, goto, source, year],
  );

  useEffect(() => setQInput(q), [q]);

  useEffect(() => {
    if (restoredRef.current || items.length === 0) return;
    const pos = readListPosition(scope);
    if (!pos) return;
    restoredRef.current = true;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(pos.slug)}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
      else window.scrollTo(0, pos.scrollY);
    });
  }, [items, scope]);

  const openDetail = (item: HubItem): void => {
    const cardId = `${item.source}:${item.slug}`;
    saveListPosition(scope, cardId, window.scrollY);
    navigate(
      `/phim/${encodeURIComponent(item.slug)}?from=${item.source}&back=${page}&q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&country=${encodeURIComponent(country)}&year=${encodeURIComponent(year)}&source=${source}`,
    );
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Phim Tổng hợp</h1>
          <p className="text-xs text-muted-foreground">Một danh sách chung từ NC và KK</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters({ q: qInput.trim(), category: "", country: "", year: "" });
          }}
          className="flex gap-2"
        >
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Tìm phim…"
            className="w-56 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <button className="rounded-md border px-3 py-2 text-sm">Tìm</button>
        </form>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => applyFilters({ source: tab.key })}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              source === tab.key ? `${tab.color} text-white shadow` : "border bg-background hover:bg-muted"
            }`}
          >
            {tab.label}
          </button>
        ))}
        {!q && (
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-background px-4 py-1.5 text-sm font-medium transition hover:bg-muted lg:hidden"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Bộ lọc
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        )}
      </div>

      <div className="flex gap-6">
        <main className="min-w-0 flex-1">
          {data?.error && <p className="mb-4 text-sm text-destructive">Lỗi: {data.error}</p>}

          <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 ${!q ? "lg:grid-cols-5" : "lg:grid-cols-6"}`}>
        {(isLoading ? Array.from({ length: 12 }) : items).map((it, i) => {
          if (!it) {
            return (
              <div key={i} className="animate-pulse">
                <div className="aspect-[2/3] w-full rounded-md bg-muted" />
                <div className="mt-2 h-4 w-3/4 rounded bg-muted" />
              </div>
            );
          }
          const item = it as HubItem;
          const cardId = `${item.source}:${item.slug}`;
          const availableSources = item.availableSources ?? [item.source];
          return (
            <Link
              key={cardId}
              to={`/phim/${encodeURIComponent(item.slug)}?from=${item.source}&back=${page}&q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&country=${encodeURIComponent(country)}&year=${encodeURIComponent(year)}&source=${source}`}
              data-card-id={cardId}
              onClick={(e) => {
                e.preventDefault();
                openDetail(item);
              }}
              className="group"
            >
              <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-muted">
                {item.poster && (
                  <img
                    src={item.poster}
                    alt={item.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover transition group-hover:scale-105"
                  />
                )}
                {item.epLabel && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                    {item.epLabel}
                  </span>
                )}
              </div>
              <div className="mt-1.5 line-clamp-2 text-sm font-medium">{item.title}</div>
              {item.originName && (
                <div className="line-clamp-1 text-xs text-muted-foreground">{item.originName}</div>
              )}
              {source === "all" && (
                <div className="mt-1 flex gap-1">
                  {availableSources.map((availableSource) => (
                    <span
                      key={availableSource}
                      className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground"
                    >
                      {SOURCE_LABEL[availableSource]}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          );
        })}
          </div>

          <Pagination
            page={page}
            maxPage={maxPage}
            onGo={(nextPage) => {
              window.scrollTo({ top: 0, behavior: "smooth" });
              goto({ page: nextPage });
            }}
          />
        </main>

        {!q && (
          <aside className="hidden w-72 shrink-0 lg:block" aria-label="Bộ lọc phim">
            <div className="sticky top-4 rounded-xl border bg-muted/30 p-4">
              <FilterPanel
                categories={categories}
                countries={countries}
                category={category}
                country={country}
                year={year}
                isLoadingFilters={isLoadingFilters}
                selectedCategory={selectedCategory}
                selectedCountry={selectedCountry}
                source={source}
                hasFilter={hasFilter}
                onApply={applyFilters}
              />
            </div>
          </aside>
        )}
      </div>

      {!q && filtersOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Bộ lọc phim">
          <button
            type="button"
            aria-label="Đóng bộ lọc"
            onClick={() => setFiltersOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-black/50"
          />
          <div className="absolute right-0 top-0 flex h-full w-[19rem] max-w-[88vw] flex-col overflow-y-auto border-l bg-background p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Bộ lọc</h2>
              <button
                type="button"
                aria-label="Đóng bộ lọc"
                onClick={() => setFiltersOpen(false)}
                className="inline-flex min-h-9 items-center justify-center rounded-md px-2.5 text-sm transition hover:bg-muted"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <FilterPanel
              categories={categories}
              countries={countries}
              category={category}
              country={country}
              year={year}
              isLoadingFilters={isLoadingFilters}
              selectedCategory={selectedCategory}
              selectedCountry={selectedCountry}
              source={source}
              hasFilter={hasFilter}
              onApply={applyFilters}
              onApplied={(patch) => {
                if (patch.category || patch.country || patch.year) setFiltersOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type FilterPanelProps = {
  categories: FilterOption[];
  countries: FilterOption[];
  category: string;
  country: string;
  year: string;
  isLoadingFilters: boolean;
  selectedCategory: FilterOption | undefined;
  selectedCountry: FilterOption | undefined;
  source: HubFeedSource;
  hasFilter: boolean;
  onApply: (patch: Partial<SearchState>) => void;
  onApplied?: (patch: Partial<SearchState>) => void;
};

function FilterPanel({
  categories,
  countries,
  category,
  country,
  year,
  isLoadingFilters,
  selectedCategory,
  selectedCountry,
  source,
  hasFilter,
  onApply,
  onApplied,
}: FilterPanelProps) {
  const apply = (patch: Partial<SearchState>): void => {
    onApply(patch);
    onApplied?.(patch);
  };

  return (
    <div>
      {hasFilter && (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => apply({ category: "", country: "", year: "" })}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-background hover:text-foreground"
          >
            <X size={14} aria-hidden="true" />
            Đặt lại
          </button>
        </div>
      )}

      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Tags size={14} aria-hidden="true" />
            Thể loại
          </span>
          <select
            aria-label="Lọc theo thể loại"
            value={category}
            disabled={isLoadingFilters}
            onChange={(e) => apply({ category: e.target.value })}
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          >
            <option value="">{isLoadingFilters ? "Đang tải thể loại…" : "Tất cả thể loại"}</option>
            {categories.map((option) => (
              <option key={option.slug} value={option.slug}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MapPin size={14} aria-hidden="true" />
            Quốc gia / vùng lãnh thổ
          </span>
          <select
            aria-label="Lọc theo quốc gia hoặc vùng lãnh thổ"
            value={country}
            disabled={isLoadingFilters}
            onChange={(e) => apply({ country: e.target.value })}
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          >
            <option value="">{isLoadingFilters ? "Đang tải quốc gia…" : "Tất cả quốc gia"}</option>
            {countries.map((option) => (
              <option key={option.slug} value={option.slug}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 text-xs font-medium text-muted-foreground">Năm phát hành</span>
          <select
            aria-label="Lọc theo năm phát hành"
            value={year}
            onChange={(e) => apply({ year: e.target.value })}
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Tất cả năm</option>
            {YEARS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      {hasFilter && (
        <div className="mt-4 flex flex-wrap items-center gap-2" aria-live="polite">
          <span className="text-xs text-muted-foreground">Đang lọc:</span>
          {selectedCategory && (
            <button
              type="button"
              onClick={() => apply({ category: "" })}
              className="inline-flex min-h-7 items-center gap-1 rounded-full bg-sky-100 px-2.5 text-xs font-medium text-sky-900 transition hover:bg-sky-200"
            >
              {selectedCategory.name}
              <X size={12} aria-hidden="true" />
            </button>
          )}
          {selectedCountry && (
            <button
              type="button"
              onClick={() => apply({ country: "" })}
              className="inline-flex min-h-7 items-center gap-1 rounded-full bg-emerald-100 px-2.5 text-xs font-medium text-emerald-900 transition hover:bg-emerald-200"
            >
              {selectedCountry.name}
              <X size={12} aria-hidden="true" />
            </button>
          )}
          {year && (
            <button
              type="button"
              onClick={() => apply({ year: "" })}
              className="inline-flex min-h-7 items-center gap-1 rounded-full bg-amber-100 px-2.5 text-xs font-medium text-amber-900 transition hover:bg-amber-200"
            >
              {year}
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {source === "nguonc" && (
        <p className="mt-4 text-[11px] text-muted-foreground">
          NC lọc trực tiếp theo một tiêu chí mỗi lần. Chọn Thể loại, Quốc gia hoặc Năm; khi chọn tiêu chí mới, tiêu chí trước sẽ tự được thay thế.
        </p>
      )}
    </div>
  );
}

function Pagination({
  page,
  maxPage,
  onGo,
}: {
  page: number;
  maxPage: number;
  onGo: (page: number) => void;
}) {
  if (maxPage <= 1) return null;
  const nums: number[] = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(maxPage, start + 4);
  for (let index = start; index <= end; index += 1) nums.push(index);
  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
      <button
        disabled={page <= 1}
        onClick={() => onGo(page - 1)}
        className="rounded-md border px-3 py-1 text-sm disabled:opacity-40"
      >
        ‹
      </button>
      {nums.map((number) => (
        <button
          key={number}
          onClick={() => onGo(number)}
          className={`rounded-md px-3 py-1 text-sm ${number === page ? "bg-primary text-primary-foreground" : "border"}`}
        >
          {number}
        </button>
      ))}
      <button
        disabled={page >= maxPage}
        onClick={() => onGo(page + 1)}
        className="rounded-md border px-3 py-1 text-sm disabled:opacity-40"
      >
        ›
      </button>
    </div>
  );
}
