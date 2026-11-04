const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
