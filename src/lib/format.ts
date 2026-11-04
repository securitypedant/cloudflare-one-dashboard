import type { Unit } from "../../shared/types.ts";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number): string {
	let value = bytes;
	let i = 0;
	while (value >= 1000 && i < BYTE_UNITS.length - 1) {
		value /= 1000;
		i++;
	}
	return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

/** Value without the unit suffix (bytes are always scaled, e.g. "1.2 GB"). */
export function formatAmount(value: number, unit: Unit): string {
	return unit === "bytes" ? formatBytes(value) : compact.format(value);
}

export function formatValue(value: number, unit: Unit): string {
	return unit === "bytes" ? formatBytes(value) : `${compact.format(value)} ${unit}`;
}

export const escapeHtml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const formatKm = (km: number) => `${Math.round(km).toLocaleString()} km`;

/** "▲12%", "▼8%", "new", or "" when there's nothing to compare. */
export function formatChange(change: number | "new" | null): string {
	if (change === null) return "";
	if (change === "new") return "new";
	const pct = Math.abs(change) * 100;
	const digits = pct < 10 ? 1 : 0;
	return `${change >= 0 ? "▲" : "▼"}${pct.toFixed(digits)}%`;
}

export function formatShare(share: number): string {
	if (share > 0 && share < 0.001) return "<0.1%";
	return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}
