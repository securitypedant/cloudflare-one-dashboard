import type { Vendor } from "../../shared/types.ts";
import { VENDOR_PALETTE, vendorColor } from "../lib/vendors.ts";

interface Props {
	vendors: Vendor[] | undefined;
	selected: string[];
	onChange: (ids: string[]) => void;
}

/** Add other SASE vendors' POPs to the map; each selected vendor gets its own colour. */
export function VendorPicker({ vendors, selected, onChange }: Props) {
	const available = (vendors ?? []).filter((v) => !selected.includes(v.id));
	return (
		<div className="vendor-picker">
			<span className="toolbar-label">Compare with</span>
			{selected.map((id) => {
				const v = vendors?.find((x) => x.id === id);
				const color = vendorColor(selected, id);
				return (
					<button key={id} className="vendor-chip" style={{ borderColor: color }} onClick={() => onChange(selected.filter((s) => s !== id))} title="Remove">
						<i className="diamond" style={{ background: color }} />
						{v?.name ?? id} <span className="muted">({v?.points.length ?? "…"})</span> ×
					</button>
				);
			})}
			{selected.length < VENDOR_PALETTE.length && available.length > 0 && (
				<select value="" onChange={(e) => e.target.value && onChange([...selected, e.target.value])} aria-label="Add vendor">
					<option value="">{selected.length ? "+ vendor" : "Add vendor POPs…"}</option>
					{available.map((v) => (
						<option key={v.id} value={v.id}>
							{v.name} ({v.points.length} POPs)
						</option>
					))}
				</select>
			)}
		</div>
	);
}
