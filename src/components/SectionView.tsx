import type { ReactNode } from "react";
import type { Section as SectionResult } from "../../shared/admin.ts";

/** Renders a report section, or explains why it's unavailable (e.g. which token permission to add). */
export function SectionView<T>({ result, children }: { result: SectionResult<T> | undefined; children: (data: T) => ReactNode }) {
	if (!result) return null;
	if (result.ok) return <>{children(result.data)}</>;
	return (
		<div className={result.missingPermission ? "permission-note" : "error-text"}>
			{result.missingPermission ? (
				<>
					Needs the <code>{result.missingPermission}</code> permission on the dashboard's API token.
				</>
			) : (
				result.error
			)}
		</div>
	);
}
