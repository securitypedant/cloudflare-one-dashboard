/**
 * Map popup content as data, rendered with DOM APIs (textContent / CSSOM). Nothing is ever parsed
 * as HTML, so third-party or log-derived strings (vendor cities, ISP names) can't inject markup.
 */
export type PopupLine = string | { text: string; color?: string; muted?: boolean; swatch?: string };

export interface PopupContent {
	title: string;
	lines: PopupLine[];
}

export function renderPopup({ title, lines }: PopupContent): HTMLElement {
	const root = document.createElement("div");
	const strong = document.createElement("strong");
	strong.textContent = title;
	root.appendChild(strong);
	for (const line of lines) {
		const row = document.createElement("div");
		row.className = "popup-row";
		const l = typeof line === "string" ? { text: line } : line;
		if (l.swatch) {
			const i = document.createElement("i");
			i.style.background = l.swatch;
			row.appendChild(i);
		}
		row.appendChild(document.createTextNode(l.text));
		if (l.color) row.style.color = l.color;
		if (l.muted) row.classList.add("muted");
		root.appendChild(row);
	}
	return root;
}
