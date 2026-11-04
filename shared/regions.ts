// Regional Services managed regions that can be checked from a data center's country.
// Source: https://developers.cloudflare.com/data-localization/region-support/
// Certification-based regions (FedRAMP, IRAP, ISO 27001, Green Energy), US state regions and custom
// regions depend on Cloudflare-internal data center lists and are not modelled here.

const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
const SCHENGEN = ["AT", "BE", "BG", "HR", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CH"];
const NATO = ["AL", "BE", "BG", "CA", "HR", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IT", "LV", "LT", "LU", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "TR", "GB", "US"];

export interface Region {
	id: string;
	label: string;
	/** Allowed countries, or excluded countries for "Exclusive of" regions. */
	countries: string[];
	exclusive?: boolean;
}

export const REGIONS: Region[] = [
	{ id: "eu", label: "European Union", countries: EU },
	{ id: "schengen", label: "Schengen Area", countries: SCHENGEN },
	{ id: "us", label: "United States of America", countries: ["US"] },
	{ id: "ca", label: "Canada", countries: ["CA"] },
	{ id: "uk", label: "United Kingdom", countries: ["GB"] },
	{ id: "au", label: "Australia", countries: ["AU"] },
	{ id: "in", label: "India", countries: ["IN"] },
	{ id: "jp", label: "Japan", countries: ["JP"] },
	{ id: "ismap", label: "ISMAP (Japan)", countries: ["JP"] },
	{ id: "sg", label: "Singapore", countries: ["SG"] },
	{ id: "kr", label: "South Korea", countries: ["KR"] },
	{ id: "br", label: "Brazil", countries: ["BR"] },
	{ id: "za", label: "South Africa", countries: ["ZA"] },
	{ id: "de", label: "Germany", countries: ["DE"] },
	{ id: "c5", label: "C5:2020 (Germany)", countries: ["DE"] },
	{ id: "fr", label: "France", countries: ["FR"] },
	{ id: "it", label: "Italy", countries: ["IT"] },
	{ id: "nl", label: "Netherlands", countries: ["NL"] },
	{ id: "es", label: "Spain", countries: ["ES"] },
	{ id: "ens", label: "ENS (Spain)", countries: ["ES"] },
	{ id: "at", label: "Austria", countries: ["AT"] },
	{ id: "ch", label: "Switzerland", countries: ["CH"] },
	{ id: "tr", label: "Turkey", countries: ["TR"] },
	{ id: "ae", label: "United Arab Emirates", countries: ["AE"] },
	{ id: "sa", label: "Saudi Arabia", countries: ["SA"] },
	{ id: "hk", label: "Hong Kong", countries: ["HK"] },
	{ id: "tw", label: "Taiwan", countries: ["TW"] },
	{ id: "ru", label: "Russia", countries: ["RU"] },
	{ id: "nato", label: "NATO", countries: NATO },
	{ id: "ex-hk-mo", label: "Exclusive of Hong Kong and Macau", countries: ["HK", "MO"], exclusive: true },
	{ id: "ex-ru-by", label: "Exclusive of Russia and Belarus", countries: ["RU", "BY"], exclusive: true },
];

/** Whether a data center in `country` is allowed by the region. */
export function inRegion(region: Region, country: string): boolean {
	const listed = region.countries.includes(country.toUpperCase());
	return region.exclusive ? !listed : listed;
}
