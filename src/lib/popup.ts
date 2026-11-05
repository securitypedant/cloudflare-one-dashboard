/**
 * Map popup content as data, rendered with DOM APIs (textContent / CSSOM). Nothing is ever parsed
 * as HTML, so third-party or log-derived strings (vendor cities, ISP names) can't inject markup.
 */
export type PopupLine = string | { text: string; color?: string; muted?: boolean; swatch?: string };

export interface PopupContent {
	title: string;
	lines: PopupLine[];
}

/** Only hex colours reach CSSOM, so a future caller can't pass arbitrary CSS (e.g. url()) from data. */
const HEX = /^#[0-9a-f]{3,8}$/i;
const safeColor = (c: string | undefined) => (c && HEX.test(c) ? c : undefined);

export function renderPopup({ title, lines }: PopupContent): HTMLElement {
	const root = document.createElement("div");
	const strong = document.createElement("strong");
	strong.textContent = title;
	root.appendChild(strong);
	for (const line of lines) {
		const row = document.createElement("div");
		row.className = "popup-row";
		const l = typeof line === "string" ? { text: line } : line;
		const swatch = safeColor(l.swatch);
		if (swatch) {
			const i = document.createElement("i");
			i.style.background = swatch;
			row.appendChild(i);
		}
		row.appendChild(document.createTextNode(l.text));
		const color = safeColor(l.color);
		if (color) row.style.color = color;
		if (l.muted) row.classList.add("muted");
		root.appendChild(row);
	}
	return root;
}
