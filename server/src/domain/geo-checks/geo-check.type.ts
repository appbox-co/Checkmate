import type { MonitorType } from "@/domain/monitors/monitor.type.js";

export const GeoContinents = ["EU", "NA", "AS", "SA", "AF", "OC"] as const;
export type GeoContinent = (typeof GeoContinents)[number];

export interface GeoCheckMetadata {
	monitorId: string;
	teamId: string;
	type: MonitorType;
}

export interface GeoCheckTimings {
	total: number;
	dns: number;
	tcp: number;
	tls: number;
	firstByte: number;
	download: number;
}

export interface GeoCheckLocation {
	continent: GeoContinent;
	region: string;
	country: string;
	state: string;
	city: string;
	longitude: number;
	latitude: number;
}

export interface GeoCheckResult {
	location: GeoCheckLocation;
	status: boolean;
	statusCode: number;
	timings: GeoCheckTimings;
}

// A geographic observation travels through the existing per-monitor evaluation queue.
export interface GeoCheckObservation {
	configuration: string;
	checkedAt: string;
	results: GeoCheckResult[];
	// Absent on legacy observations, which were always full sweeps.
	fullCheckAt?: string;
	recoveryOnly?: boolean;
	pendingLocations?: GeoContinent[];
}

export interface GeoCheckFailure {
	location: GeoCheckLocation;
	statusCode: number;
	checkedAt: string;
}

export interface GeoCheckState {
	configuration: string;
	checkedAt?: string; // absent until the first conclusive geographic observation
	lastFullCheckAt?: string;
	pendingLocations?: GeoContinent[];
	failures: GeoCheckFailure[];
	// Retain affected locations until the combined local/geographic outage recovers.
	outageLocations: GeoCheckFailure[];
}

export interface GeoCheck {
	id: string;
	metadata: GeoCheckMetadata;
	results: GeoCheckResult[];
	expiry: string;
	__v: number;
	createdAt: string;
	updatedAt: string;
}

export interface FlatGeoCheck {
	id: string;
	monitorId: string;
	teamId: string;
	type: string;
	location: GeoCheckLocation;
	status: boolean;
	statusCode: number;
	timings: GeoCheckTimings;
	createdAt: string;
	updatedAt: string;
}

export interface GroupedGeoCheck {
	bucketDate: string;
	continent: GeoContinent;
	avgResponseTime: number;
	totalChecks: number;
	uptimePercentage: number;
}

export interface GeoChecksResult {
	monitorType: Exclude<MonitorType, "hardware" | "pagespeed">;
	groupedGeoChecks: GroupedGeoCheck[];
}
