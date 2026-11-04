import { useState } from "react";
import { RANGE_IDS, type Pop, type RangeId } from "../shared/types.ts";
import { useApi } from "./lib/api.ts";
import { TrafficView } from "./views/TrafficView.tsx";
import { CoverageView } from "./views/CoverageView.tsx";
import { EntryExitView } from "./views/EntryExitView.tsx";
import { UserLocationsView } from "./views/UserLocationsView.tsx";
import { PerformanceView } from "./views/PerformanceView.tsx";
import { SecurityView } from "./views/SecurityView.tsx";
import "./App.css";

const RANGE_LABELS: Record<RangeId, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days" };

const TABS = [
	{ id: "traffic", label: "Traffic" },
	{ id: "coverage", label: "Coverage" },
	{ id: "users", label: "User locations" },
	{ id: "entry-exit", label: "Entry & exit" },
	{ id: "performance", label: "Performance" },
	{ id: "security", label: "Security" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const initialTab = (): TabId => {
	const hash = location.hash.slice(1);
	return TABS.some((t) => t.id === hash) ? (hash as TabId) : "traffic";
};

export default function App() {
	const [tab, setTab] = useState<TabId>(initialTab);
	const [range, setRange] = useState<RangeId>("7d");
	// Vendor POP overlays, shared by the Traffic and Coverage maps.
	const [vendorIds, setVendorIds] = useState<string[]>([]);
	const pops = useApi<Pop[]>("/api/pops");
	const popList = pops.data ?? [];

	const selectTab = (id: TabId) => {
		setTab(id);
		history.replaceState(null, "", `#${id}`);
	};

	return (
		<div className="app">
			<header className="header">
				<div className="title">
					<h1>Cloudflare One Dashboard</h1>
					<p className="muted">Where your Zero Trust traffic meets the Cloudflare network</p>
				</div>
				<nav className="tabs" role="tablist" aria-label="Reports">
					{TABS.map((t) => (
						<button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => selectTab(t.id)}>
							{t.label}
						</button>
					))}
				</nav>
				<select value={range} onChange={(e) => setRange(e.target.value as RangeId)} aria-label="Time range">
					{RANGE_IDS.map((r) => (
						<option key={r} value={r}>
							{RANGE_LABELS[r]}
						</option>
					))}
				</select>
			</header>

			{pops.error && <div className="banner error">Could not load Cloudflare POP locations: {pops.error}</div>}

			{tab === "traffic" && <TrafficView range={range} pops={popList} vendorIds={vendorIds} onVendorIds={setVendorIds} />}
			{tab === "coverage" && <CoverageView range={range} pops={popList} vendorIds={vendorIds} onVendorIds={setVendorIds} />}
			{tab === "users" && <UserLocationsView range={range} pops={popList} vendorIds={vendorIds} onVendorIds={setVendorIds} />}
			{tab === "entry-exit" && <EntryExitView range={range} pops={popList} />}
			{tab === "performance" && <PerformanceView range={range} pops={popList} />}
			{tab === "security" && <SecurityView range={range} pops={popList} />}
		</div>
	);
}
