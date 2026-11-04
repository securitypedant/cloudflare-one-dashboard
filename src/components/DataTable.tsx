import { useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
	key: string;
	label: string;
	render: (row: T) => ReactNode;
	/** Sort value; columns without it aren't sortable. */
	sort?: (row: T) => number | string;
	align?: "left" | "right";
	width?: string;
}

export interface Facet<T> {
	key: string;
	label: string;
	value: (row: T) => string;
}

interface Props<T> {
	rows: T[];
	columns: Column<T>[];
	rowKey: (row: T) => string;
	/** Text searched by the search box (lower-cased match). */
	searchText?: (row: T) => string;
	facets?: Facet<T>[];
	initialSort?: { key: string; dir: "asc" | "desc" };
	/** Optional expandable detail for a row. */
	expand?: (row: T) => ReactNode;
	pageSize?: number;
	emptyText?: string;
	/** Extra controls rendered next to the search box. */
	toolbar?: ReactNode;
	/** Externally controlled extra filter (e.g. a date picked on a chart). */
	extraFilter?: (row: T) => boolean;
	placeholder?: string;
}

/** Sortable, searchable, facet-filterable table with expandable rows and incremental paging. */
export function DataTable<T>({ rows, columns, rowKey, searchText, facets = [], initialSort, expand, pageSize = 100, emptyText = "No rows.", toolbar, extraFilter, placeholder = "Search…" }: Props<T>) {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState(initialSort);
	const [selected, setSelected] = useState<Record<string, string>>({});
	const [open, setOpen] = useState<string | null>(null);
	const [limit, setLimit] = useState(pageSize);

	const facetOptions = useMemo(
		() =>
			facets.map((f) => {
				const counts = new Map<string, number>();
				for (const r of rows) counts.set(f.value(r), (counts.get(f.value(r)) ?? 0) + 1);
				return { facet: f, options: [...counts].sort((a, b) => b[1] - a[1]) };
			}),
		[rows, facets],
	);

	const visible = useMemo(() => {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		let out = rows.filter((r) => {
			for (const f of facets) if (selected[f.key] && f.value(r) !== selected[f.key]) return false;
			if (extraFilter && !extraFilter(r)) return false;
			if (!terms.length || !searchText) return true;
			const text = searchText(r).toLowerCase();
			return terms.every((t) => text.includes(t));
		});
		const col = sort && columns.find((c) => c.key === sort.key);
		if (col?.sort) {
			const dir = sort!.dir === "asc" ? 1 : -1;
			out = [...out].sort((a, b) => {
				const va = col.sort!(a);
				const vb = col.sort!(b);
				return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))) * dir;
			});
		}
		return out;
	}, [rows, query, selected, sort, columns, facets, searchText, extraFilter]);

	const toggleSort = (key: string) =>
		setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: columns.find((c) => c.key === key)?.align === "right" ? "desc" : "asc" }));
	const activeFilters = Object.values(selected).filter(Boolean).length + (query ? 1 : 0);

	return (
		<div className="datatable">
			<div className="datatable-toolbar">
				{searchText && (
					<input type="search" value={query} placeholder={placeholder} onChange={(e) => { setQuery(e.target.value); setLimit(pageSize); }} aria-label="Search" />
				)}
				{facetOptions.map(({ facet, options }) => (
					<select
						key={facet.key}
						value={selected[facet.key] ?? ""}
						onChange={(e) => { setSelected((s) => ({ ...s, [facet.key]: e.target.value })); setLimit(pageSize); }}
						aria-label={facet.label}
					>
						<option value="">{facet.label}: all</option>
						{options.map(([v, n]) => (
							<option key={v} value={v}>
								{v || "(none)"} ({n})
							</option>
						))}
					</select>
				))}
				{activeFilters > 0 && (
					<button onClick={() => { setQuery(""); setSelected({}); }} className="link-button">
						Clear filters
					</button>
				)}
				{toolbar}
				<span className="muted datatable-count">
					{visible.length === rows.length ? `${rows.length} rows` : `${visible.length} of ${rows.length} rows`}
				</span>
			</div>
			<div className="datatable-scroll">
				<table className="table compact">
					<thead>
						<tr>
							{expand && <th style={{ width: 18 }} />}
							{columns.map((c) => (
								<th
									key={c.key}
									className={`${c.align === "right" ? "num" : ""} ${c.sort ? "sortable" : ""}`}
									style={c.width ? { width: c.width } : undefined}
									onClick={c.sort ? () => toggleSort(c.key) : undefined}
									aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
								>
									{c.label}
									{sort?.key === c.key && <span className="sort-arrow">{sort.dir === "asc" ? " ▲" : " ▼"}</span>}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{visible.slice(0, limit).map((r) => {
							const k = rowKey(r);
							const isOpen = open === k;
							return [
								<tr key={k} className={`${expand ? "clickable-row" : ""} ${isOpen ? "selected" : ""}`} onClick={expand ? () => setOpen(isOpen ? null : k) : undefined}>
									{expand && <td className="muted">{isOpen ? "▾" : "▸"}</td>}
									{columns.map((c) => (
										<td key={c.key} className={c.align === "right" ? "num" : undefined}>
											{c.render(r)}
										</td>
									))}
								</tr>,
								isOpen && expand ? (
									<tr key={`${k}-detail`} className="detail-row">
										<td colSpan={columns.length + 1}>{expand(r)}</td>
									</tr>
								) : null,
							];
						})}
						{visible.length === 0 && (
							<tr>
								<td colSpan={columns.length + (expand ? 1 : 0)} className="muted">
									{emptyText}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			{visible.length > limit && (
				<button className="link-button" onClick={() => setLimit((l) => l + pageSize)}>
					Show {Math.min(pageSize, visible.length - limit)} more
				</button>
			)}
		</div>
	);
}
