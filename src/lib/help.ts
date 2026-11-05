/** Help text for each page: what it shows, how to read it, where the data comes from, and its limits. */
export interface HelpTopic {
	title: string;
	summary: string;
	sections: { heading: string; points: string[] }[];
}

const RANGE = "Uses the time range picker in the header.";
const CHART = "Switch to Chart (top left of this row) to see the same data over time: hourly for 24h and 7d, daily for 30d and 90d. Charts show the top locations plus the total, with the change from first to last point; click a location on the map or in the table first to chart it alone. Click legend entries to hide lines.";

export const HELP: Record<string, HelpTopic> = {
	traffic: {
		title: "Traffic",
		summary: "Where your Zero Trust traffic enters the Cloudflare network, per data center (POP) or per user country.",
		sections: [
			{
				heading: "How to read it",
				points: [
					CHART,
					"Orange dots are every Cloudflare POP. Circles are sized by traffic; each dataset (DNS, HTTP, network, bandwidth, Access logins, users, devices) has its own colour and they nest at the same POP.",
					"Switch between \"By POP\" (where traffic was handled) and \"By user location\" (countries shaded by where users are).",
					"Hover a circle or country for its numbers. The sidebar ranks locations and shows the change against the previous period of the same length, plus the biggest movers.",
					"▶ Timeline plays traffic hour by hour (24h, 7d) or day by day (30d, 90d). \"Compare with\" overlays other SASE vendors' POPs as coloured diamonds.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`Logpush aggregates when they cover the range, otherwise the GraphQL Analytics API. ${RANGE}`,
					"Users and devices are distinct counts per location, so one person can appear at several POPs; cards show the busiest location instead of a total.",
					"HTTP by POP is limited to 30 days by the analytics API.",
				],
			},
		],
	},
	coverage: {
		title: "Coverage",
		summary: "Which POPs serve the users in each country, how much is served in-country, and how other SASE vendors' networks compare.",
		sections: [
			{
				heading: "How to read it",
				points: [
					CHART,
					"Each badge is \"Users in <country>\" with the share of their traffic served by a POP in the same country (green ≥ 90%, amber 50–90%, red below 50%).",
					"Arrows run from the badge to each POP that served that country: green for a POP in the same country, amber for a different country; width shows volume. Flows under 1% of a country's traffic are hidden.",
					"Click a badge or table row to focus one country. Small countries' badges slide aside with a leader line so they don't cover the POP.",
					"The vendor table estimates how much further users would travel to each vendor's nearest POP, weighted by your traffic.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`GraphQL Gateway DNS analytics (country × POP). ${RANGE}`,
					"User location is country-level, so arrows start at the country's centre, not the user's city. For city-level data, see User locations.",
					"Vendor POP lists come from sasecloudmap.com. Cloudflare scores roughly zero by design because users are measured from the Cloudflare POP that served them.",
				],
			},
		],
	},
	users: {
		title: "User locations",
		summary: "Where WARP users actually connect from (city level) and which POP each city uses.",
		sections: [
			{
				heading: "How to read it",
				points: [
					CHART,
					"Pink circles are user cities, sized by share of WARP device time (how much devices there were online), not head count.",
					"Lines run from each city to the POP it used: green when that POP is within 300 km of the city's nearest POP, amber when it's further.",
					"Hover a city for its share, the POPs used with distance and WARP handshake time, the nearest POP if different, and the ISPs.",
					"The tables show median distance to the POP, ISPs that route users to distant POPs, and a vendor comparison measured from real user cities.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`DEX device-state Logpush (city, state, ISP, POP and handshake latency per hour; no IPs or device IDs are stored). ${RANGE}`,
					"WARP users only. The city is Cloudflare's geolocation of the user's internet connection; mobile carriers sometimes geolocate to a regional hub.",
					"Which POP a user reaches is decided by their ISP's routing (anycast), so a farther POP isn't necessarily a problem; check the handshake time.",
				],
			},
		],
	},
	"entry-exit": {
		title: "Entry & exit",
		summary: "Where traffic enters Cloudflare, where it leaves when that's a different POP (e.g. dedicated egress), and which on-ramps are used.",
		sections: [
			{
				heading: "How to read it",
				points: [
					CHART,
					"Blue circles are entry POPs; lines show traffic exiting at a different POP.",
					"The on-ramp and off-ramp breakdowns show WARP, Magic WAN, proxy endpoints and so on.",
					"Rings mark Direct CNI facilities (v1/v2 dataplanes).",
					"Regional Services check: pick a region to flag entry POPs outside it.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`GraphQL network session analytics. ${RANGE}`,
					"CNI sites come from Cloudflare's public docs. The Regional Services check covers the country-based regions only; custom, FedRAMP, IRAP and US state regions can't be checked this way.",
				],
			},
		],
	},
	performance: {
		title: "Performance",
		summary: "How quickly users connect to Cloudflare, by POP or by user country, plus Digital Experience Monitoring (DEX) results.",
		sections: [
			{
				heading: "How to read it",
				points: [
					CHART,
					"Circles are coloured by average TCP handshake time from the client to Cloudflare: green under 20 ms, through to red at 100 ms or more.",
					"The DEX section shows HTTP test duration and failure rate, and WARP tunnel handshake latency, per location.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`Handshake times from GraphQL network session analytics; DEX from Logpush. ${RANGE}`,
					"DEX needs the DEX Logpush jobs and only covers devices running DEX tests.",
				],
			},
		],
	},
	security: {
		title: "Blocks",
		summary: "What Gateway blocked and where: DNS, HTTP and network blocks, DLP matches and antivirus-blocked files by country or POP.",
		sections: [
			{
				heading: "How to read it",
				points: [
					CHART,
					"Pick a metric to map it. Rates show the share of that location's traffic that was blocked.",
					"Top blocked DNS categories and top DNS categories update for the selected country.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`GraphQL Gateway analytics; category names from the Gateway categories API (needs Zero Trust Read). ${RANGE}`,
				],
			},
		],
	},
	threats: {
		title: "Threats & data",
		summary: "Security threats blocked, SaaS apps in use (Shadow IT), data loss prevention matches and malware blocked.",
		sections: [
			{
				heading: "How to read it",
				points: [
					"The charts at the top show security-risk DNS blocks, all blocked DNS, DLP matches and malware blocks over time.",
					"Security threats: blocked DNS queries in security-risk categories such as malware, phishing and command and control.",
					"Shadow IT: SaaS apps your users reach, with their review status from Cloudflare One's application review. Unapproved or unreviewed apps with uploads deserve a look.",
					"DLP: requests that matched a DLP profile, by destination. Malware: files blocked by antivirus scanning or the sandbox.",
					"Per-user columns and the most targeted users are included (unless the dashboard limits per-user detail); click a user to open User lookup.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`GraphQL Gateway DNS and HTTP analytics. ${RANGE}`,
					"User names need the Zero Trust: PII Read permission on the dashboard's token. Per-profile DLP counts aren't available from analytics.",
				],
			},
		],
	},
	identity: {
		title: "Identity",
		summary: "Cloudflare Access logins: volume, failures, and where, how and to which apps users sign in.",
		sections: [
			{
				heading: "How to read it",
				points: [
					"Charts show successful and failed logins over time (hourly for 24h and 7d, daily for 30d and 90d), broken down by country, identity provider or application.",
					"Below, totals by country, identity provider and application.",
					"A user table (logins, failures, devices, last login), seat counts with seats inactive for 30+ days that could be reclaimed, and applications with no logins (unless the dashboard limits per-user detail).",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`Access login analytics (queried in 7-day windows), plus the Access users and applications APIs. ${RANGE}`,
					"\"Failed\" includes policy denials as well as failed identity-provider logins.",
				],
			},
		],
	},
	posture: {
		title: "Posture",
		summary: "A configuration score and ranked findings for your Access, Gateway and WARP device settings.",
		sections: [
			{
				heading: "How to read it",
				points: [
					"The score starts at 100 and drops 15 points per high, 7 per medium and 2 per low finding.",
					"Expand a finding for details and where to fix it in the Cloudflare One dashboard. Filter by severity or area, or search.",
					"\"Checks run\" lists which checks ran and names any token permission a check needs.",
					"Gateway rule matches (30 days): rules with no matches may be shadowed by a higher rule or no longer needed.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					"Access, Gateway and device settings APIs; rule match counts from Gateway analytics. Not affected by the time range.",
					"Missing MFA is only checked for Access-enforced MFA; your identity provider may enforce it too.",
				],
			},
		],
	},
	devices: {
		title: "Devices",
		summary: "Your enrolled WARP devices: operating systems, client versions, and devices that haven't been seen recently.",
		sections: [
			{
				heading: "How to read it",
				points: [
					"Outdated means the WARP client is more than two releases behind the newest version in your fleet.",
					"Stale means not seen for 30 days or more. The table starts with the longest-unseen devices; filter by OS or status, or search.",
					"Click a user to open User lookup. The posture section lists the configured device posture checks.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					"Devices and device posture APIs. Not affected by the time range.",
					"Per-device posture results aren't available from the API.",
				],
			},
		],
	},
	tunnels: {
		title: "Tunnels",
		summary: "Health of your Cloudflare Tunnels (cloudflared) and Magic WAN tunnels, with connectors on the map.",
		sections: [
			{
				heading: "How to read it",
				points: [
					CHART,
					"Circles are POPs where tunnels connect, coloured by the worst status there and sized by the number of tunnels.",
					"Use the filter panel to show Cloudflare Tunnels and/or Magic WAN, pick statuses, or focus on one tunnel.",
					"Magic WAN health checks run from every Cloudflare data center; each circle is coloured by the share of that data center's checks that failed (down ≥ 50%, degraded ≥ 5%).",
					"Expand a tunnel in the table for its connectors, versions and origin IPs. Outdated connectors are more than two releases behind the newest seen.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					"Cloudflare Tunnel API; Magic WAN health checks from the last 24 hours. Not affected by the time range.",
					"Connector origin IPs are hidden if the dashboard limits per-user and internal detail. Cloudflare Tunnel status has no history, so the chart covers Magic WAN only.",
				],
			},
		],
	},
	changes: {
		title: "Changes",
		summary: "The account audit log: who changed what, when, and from where.",
		sections: [
			{
				heading: "How to read it",
				points: [
					"Search across actor, action, resource and values. Filter by actor, action, resource, interface or result, and sort any column.",
					"Click a day in the chart to show only that day. \"Zero Trust only\" hides unrelated account changes.",
					"Expand a row to see before and after values side by side, with changed lines highlighted.",
				],
			},
			{
				heading: "Data and limits",
				points: [`Audit logs API (needs Account Settings Read). Shows the newest 5,000 changes in the range. ${RANGE}`],
			},
		],
	},
	user: {
		title: "User lookup",
		summary: "Everything about one user in one place: profile, devices, sign-ins, locations and Gateway activity.",
		sections: [
			{
				heading: "How to read it",
				points: [
					"Type or pick an email. User names elsewhere in the dashboard link here.",
					"Shows last login and seats, devices, Access sign-ins by country, app and identity provider, countries and POPs used, blocked categories, top web destinations, and DLP and antivirus counts.",
				],
			},
			{
				heading: "Data and limits",
				points: [
					`Access users and devices APIs; Access and Gateway analytics. ${RANGE}`,
					"Needs the Zero Trust: PII Read permission for Gateway activity; without it, emails are redacted in analytics.",
				],
			},
		],
	},
};
