import type { DeviceRow, DevicesResponse } from "../../shared/admin.ts";
import { cfList, section } from "../cfapi.ts";
import { DAY_MS, DEVICES_PERMISSION, listDevices, outdatedChecker, type CfDevice } from "./common.ts";

export function toDeviceRows(devices: CfDevice[], now: number): { rows: DeviceRow[]; latest: string | null } {
	const active = devices.filter((d) => !d.deleted);
	const { latest, isOutdated } = outdatedChecker(active.map((d) => d.version ?? ""));
	const rows = active.map((d) => {
		const seen = d.last_seen ? Date.parse(d.last_seen) : NaN;
		return {
			id: d.id,
			name: (d.name ?? "").slice(0, 100),
			user: d.user?.email ?? "",
			os: d.device_type ?? "",
			osVersion: [d.os_distro_name, d.os_version].filter(Boolean).join(" ").slice(0, 60),
			clientVersion: d.version ?? "",
			lastSeen: d.last_seen ?? null,
			staleDays: Number.isFinite(seen) ? Math.floor((now - seen) / DAY_MS) : null,
			outdated: isOutdated(d.version ?? ""),
		};
	});
	return { rows: rows.sort((a, b) => (b.staleDays ?? 1e9) - (a.staleDays ?? 1e9)), latest };
}

export async function fetchDevices(token: string, accountId: string): Promise<DevicesResponse> {
	const [devices, posture] = await Promise.all([
		section(() => listDevices(token, accountId)),
		section(() => cfList<{ id: string; name?: string; type?: string }>(token, `/accounts/${accountId}/devices/posture`, DEVICES_PERMISSION)),
	]);
	const converted = devices.ok ? toDeviceRows(devices.data, Date.now()) : null;
	return {
		devices: converted ? { ok: true, data: converted.rows } : (devices as Exclude<typeof devices, { ok: true }>),
		latestClientVersion: converted?.latest ?? null,
		postureRules: posture.ok ? { ok: true, data: posture.data.map((p) => ({ id: p.id, name: p.name ?? p.id, type: p.type ?? "" })) } : posture,
	};
}
