import type { ReactNode } from "react";
import type { Severity } from "../../shared/admin.ts";
import { SEVERITY_COLORS } from "../lib/colors.ts";

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="stat">
			<div className="stat-value">{value}</div>
			<div className="stat-label">{label}</div>
			{hint && <div className="stat-hint">{hint}</div>}
		</div>
	);
}

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<section className="section">
			<h2>{title}</h2>
			{hint && <p className="section-hint">{hint}</p>}
			{children}
		</section>
	);
}

/** Labelled horizontal bar (share 0..1). */
export function BarRow({ label, share, value, color }: { label: ReactNode; share: number; value: string; color: string }) {
	return (
		<div className="bar-row">
			<div className="bar-row-label">{label}</div>
			<div className="bar-row-track">
				<span style={{ width: `${Math.min(1, share) * 100}%`, background: color }} />
			</div>
			<div className="bar-row-value">{value}</div>
		</div>
	);
}

/** Shown while a view's data loads or when it fails. */
export function Status({ loading, error }: { loading?: boolean; error?: string }) {
	if (error) return <div className="error-text">{error}</div>;
	if (loading) return <div className="muted">Loading…</div>;
	return null;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
	return (
		<span className="severity" style={{ borderColor: SEVERITY_COLORS[severity], color: SEVERITY_COLORS[severity] }}>
			{severity}
		</span>
	);
}

/** Coloured status pill (healthy/degraded/down, approved/unapproved, …). */
export function StatusPill({ text, color }: { text: string; color: string }) {
	return (
		<span className="severity" style={{ borderColor: color, color }}>
			{text}
		</span>
	);
}
