import { useState } from "react";
import { RANGE_IDS, type Pop, type RangeId } from "../shared/types.ts";
import type { MeResponse } from "../shared/admin.ts";
import { useApi } from "./lib/api.ts";
import { TrafficView } from "./views/TrafficView.tsx";
import { CoverageView } from "./views/CoverageView.tsx";
import { EntryExitView } from "./views/EntryExitView.tsx";
import { UserLocationsView } from "./views/UserLocationsView.tsx";
import { PerformanceView } from "./views/PerformanceView.tsx";
import { SecurityView } from "./views/SecurityView.tsx";
import { ThreatsView } from "./views/ThreatsView.tsx";
import { IdentityView } from "./views/IdentityView.tsx";
import { PostureView } from "./views/PostureView.tsx";
import { DevicesView } from "./views/DevicesView.tsx";
import { TunnelsView } from "./views/TunnelsView.tsx";
import { ChangesView } from "./views/ChangesView.tsx";
import { UserView } from "./views/UserView.tsx";
import { HelpPanel } from "./components/HelpPanel.tsx";
import { SessionPanel } from "./components/SessionPanel.tsx";
import { HELP } from "./lib/help.ts";
import "./App.css";

const RANGE_LABELS: Record<RangeId, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days" };

const GROUPS = [
	{
		id: "network",
		label: "Network",
		admin: false,
		tabs: [
			{ id: "traffic", label: "Traffic" },
			{ id: "coverage", label: "Coverage" },
			{ id: "users", label: "User locations" },
			{ id: "entry-exit", label: "Entry & exit" },
			{ id: "performance", label: "Performance" },
		],
	},
	{
		id: "security",
		label: "Security",
		admin: false,
		tabs: [
			{ id: "security", label: "Blocks" },
			{ id: "threats", label: "Threats & data" },
			{ id: "identity", label: "Identity" },
		],
	},
	{
		id: "admin",
		label: "Admin",
		admin: true,
		tabs: [
			{ id: "posture", label: "Posture" },
			{ id: "devices", label: "Devices" },
			{ id: "tunnels", label: "Tunnels" },
			{ id: "changes", label: "Changes" },
			{ id: "user", label: "User lookup" },
		],
	},
] as const;
type TabId = (typeof GROUPS)[number]["tabs"][number]["id"];
const ALL_TABS = GROUPS.flatMap((g) => g.tabs.map((t) => ({ ...t, group: g.id, admin: g.admin })));
/** Tabs whose content doesn't depend on the time range. */
const NO_RANGE: TabId[] = ["posture", "devices", "tunnels"];

const initialTab = (): TabId => {
	const hash = location.hash.slice(1);
	return ALL_TABS.some((t) => t.id === hash) ? (hash as TabId) : "traffic";
};

export default function App() {
	const [tab, setTab] = useState<TabId>(initialTab);
	const [range, setRange] = useState<RangeId>("7d");
	const [userEmail, setUserEmail] = useState<string | null>(null);
	// Vendor POP overlays, shared by the Traffic and Coverage maps.
	const [vendorIds, setVendorIds] = useState<string[]>([]);
	const pops = useApi<Pop[]>("/api/pops");
	const me = useApi<MeResponse>("/api/me");
	const popList = pops.data ?? [];
	const role = me.data?.role ?? "viewer";
	const groups = GROUPS.filter((g) => !g.admin || role === "admin");
	const current = ALL_TABS.find((t) => t.id === tab);
	// A viewer who lands on an admin tab (e.g. via a shared link) falls back to Traffic.
	const active: TabId = current && (!current.admin || role === "admin") ? tab : "traffic";
	const activeGroup = ALL_TABS.find((t) => t.id === active)!.group;
	const activeGroupDef = GROUPS.find((g) => g.id === activeGroup)!;
	// Remember the last page opened in each group, so switching groups returns to it.
	const [lastInGroup, setLastInGroup] = useState<Record<string, TabId>>({});
	const [helpOpen, setHelpOpen] = useState(false);
	const [sessionOpen, setSessionOpen] = useState(false);

	const selectTab = (id: TabId) => {
		setTab(id);
		setLastInGroup((m) => ({ ...m, [ALL_TABS.find((t) => t.id === id)!.group]: id }));
		history.replaceState(null, "", `#${id}`);
	};
	const selectGroup = (g: (typeof GROUPS)[number]) => selectTab(lastInGroup[g.id] ?? g.tabs[0].id);
	const openUser = (email: string) => {
		setUserEmail(email.toLowerCase());
		selectTab("user");
	};

	return (
		<div className="app">
			<header className="header">
				<div className="title">
					<h1>Cloudflare One Ops Dashboard</h1>
					<p className="muted">
						Read-only operational view of your account. Make changes in the Cloudflare dashboard
						{me.data && (
							<>
								{" · "}
								<button className="link-button session-link" onClick={() => setSessionOpen(true)} aria-haspopup="dialog" title="Your identity, connection and account">
									{me.data.email} ({me.data.role})
								</button>
							</>
						)}
					</p>
				</div>
				<nav className="tabs group-tabs" role="tablist" aria-label="Report groups">
					{groups.map((g) => (
						<button key={g.id} role="tab" aria-selected={activeGroup === g.id} className={activeGroup === g.id ? "active" : ""} onClick={() => selectGroup(g)}>
							{g.label}
						</button>
					))}
				</nav>
				<select value={range} onChange={(e) => setRange(e.target.value as RangeId)} aria-label="Time range" disabled={NO_RANGE.includes(active)}>
					{RANGE_IDS.map((r) => (
						<option key={r} value={r}>
							{RANGE_LABELS[r]}
						</option>
					))}
				</select>
			</header>
			<nav className="subnav" role="tablist" aria-label={`${activeGroupDef.label} reports`}>
				{activeGroupDef.tabs.map((t) => (
					<button key={t.id} role="tab" aria-selected={active === t.id} className={active === t.id ? "active" : ""} onClick={() => selectTab(t.id)}>
						{t.label}
					</button>
				))}
				<button className="help-button" onClick={() => setHelpOpen(true)} aria-haspopup="dialog" title="What does this page show?">
					? Help
				</button>
			</nav>
			{helpOpen && HELP[active] && <HelpPanel topic={HELP[active]} onClose={() => setHelpOpen(false)} />}
			{sessionOpen && <SessionPanel onClose={() => setSessionOpen(false)} />}

			{pops.error && <div className="banner error">Could not load Cloudflare POP locations: {pops.error}</div>}
			{role === "admin" && me.data && !me.data.adminGroupsConfigured && me.data.email !== "local-dev" && (
				<div className="banner">Admin views are hidden for everyone until ADMIN_GROUPS is set in the Worker config.</div>
			)}

			{active === "traffic" && <TrafficView range={range} pops={popList} vendorIds={vendorIds} onVendorIds={setVendorIds} />}
			{active === "coverage" && <CoverageView range={range} pops={popList} vendorIds={vendorIds} onVendorIds={setVendorIds} />}
			{active === "users" && <UserLocationsView range={range} pops={popList} vendorIds={vendorIds} onVendorIds={setVendorIds} />}
			{active === "entry-exit" && <EntryExitView range={range} pops={popList} />}
			{active === "performance" && <PerformanceView range={range} pops={popList} />}
			{active === "security" && <SecurityView range={range} pops={popList} />}
			{active === "threats" && <ThreatsView range={range} role={role} onOpenUser={openUser} />}
			{active === "identity" && <IdentityView range={range} role={role} onOpenUser={openUser} />}
			{active === "posture" && <PostureView />}
			{active === "devices" && <DevicesView onOpenUser={openUser} />}
			{active === "tunnels" && <TunnelsView pops={popList} />}
			{active === "changes" && <ChangesView range={range} />}
			{active === "user" && <UserView range={range} email={userEmail} onEmail={setUserEmail} />}
		</div>
	);
}
