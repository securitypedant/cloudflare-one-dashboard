import { useEffect, useRef } from "react";
import type { HelpTopic } from "../lib/help.ts";

/** Slide-in panel explaining the current page. Closes on Escape, the close button, or a click outside. */
export function HelpPanel({ topic, onClose }: { topic: HelpTopic; onClose: () => void }) {
	const closeRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		closeRef.current?.focus();
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="help-backdrop" onClick={onClose}>
			<aside className="help-panel" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()}>
				<header>
					<h2 id="help-title">{topic.title}</h2>
					<button ref={closeRef} className="link-button" onClick={onClose} aria-label="Close help">
						✕
					</button>
				</header>
				<p className="help-summary">{topic.summary}</p>
				{topic.sections.map((s) => (
					<section key={s.heading}>
						<h3>{s.heading}</h3>
						<ul>
							{s.points.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					</section>
				))}
			</aside>
		</div>
	);
}
