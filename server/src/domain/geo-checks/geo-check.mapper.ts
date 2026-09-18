import type { GeoCheckFailure, GeoCheckLocation, GeoCheckObservation, GeoCheckResult, GeoCheckState } from "./geo-check.type.js";

// Select entity fields explicitly: repository callers may supply lean objects or Mongoose subdocuments.
const location = (value: GeoCheckLocation): GeoCheckLocation => ({
	continent: value.continent,
	country: value.country,
	region: value.region,
	state: value.state,
	city: value.city,
	latitude: value.latitude,
	longitude: value.longitude,
});
const failure = (value: GeoCheckFailure): GeoCheckFailure => ({
	location: location(value.location),
	statusCode: value.statusCode,
	checkedAt: value.checkedAt,
});
const result = (value: GeoCheckResult): GeoCheckResult => ({
	location: location(value.location),
	status: value.status,
	statusCode: value.statusCode,
	timings: {
		total: value.timings.total,
		dns: value.timings.dns,
		tcp: value.timings.tcp,
		tls: value.timings.tls,
		firstByte: value.timings.firstByte,
		download: value.timings.download,
	},
});
export const toGeoCheckState = (value?: GeoCheckState): GeoCheckState | undefined =>
	value && {
		configuration: value.configuration,
		checkedAt: value.checkedAt,
		lastFullCheckAt: value.lastFullCheckAt,
		pendingLocations: value.pendingLocations && [...value.pendingLocations],
		failures: value.failures.map(failure),
		outageLocations: value.outageLocations.map(failure),
	};
export const toGeoCheckObservation = (value?: GeoCheckObservation): GeoCheckObservation | undefined =>
	value && {
		configuration: value.configuration,
		checkedAt: value.checkedAt,
		fullCheckAt: value.fullCheckAt,
		recoveryOnly: value.recoveryOnly,
		pendingLocations: value.pendingLocations && [...value.pendingLocations],
		results: value.results.map(result),
	};
