import type { DatasetId } from "../../shared/types.ts";

/** Cloudflare orange, reserved for POP dots so traffic colours never clash with them. */
export const POP_COLOR = "#f6821f";

export const DATASET_COLORS: Record<DatasetId, string> = {
	dns: "#38bdf8",
	http: "#a78bfa",
	network: "#4ade80",
	bandwidth: "#f472b6",
	access: "#facc15",
	users: "#f87171",
	devices: "#2dd4bf",
};

export const DATASET_SHORT: Record<DatasetId, string> = {
	dns: "DNS",
	http: "HTTP",
	network: "Net",
	bandwidth: "BW",
	access: "Access",
	users: "Users",
	devices: "Devs",
};

export const SEVERITY_COLORS = { high: "#f87171", medium: "#fb923c", low: "#facc15", info: "#94a3b8" } as const;

export const STATUS_COLORS: Record<string, string> = {
	healthy: "#4ade80",
	approved: "#4ade80",
	degraded: "#facc15",
	inReview: "#facc15",
	unreviewed: "#94a3b8",
	inactive: "#94a3b8",
	unknown: "#94a3b8",
	down: "#f87171",
	unapproved: "#f87171",
};
