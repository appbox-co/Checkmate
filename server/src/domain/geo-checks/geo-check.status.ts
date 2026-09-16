import { createHash } from "node:crypto";
import type { Monitor } from "@/domain/monitors/monitor.type.js";
import { supportsGeoCheck } from "@/domain/monitors/monitor.type.js";
import type { Check } from "@/domain/checks/check.type.js";
import type { GeoCheck, GeoCheckFailure, GeoCheckLocation, GeoCheckObservation, GeoCheckState } from "./geo-check.type.js";
import { NETWORK_ERROR } from "@/types/network.js";

export const geoCheckConfiguration = (monitor: Monitor): string =>
	createHash("sha256")
		.update(
			JSON.stringify({
				type: monitor.type,
				url: monitor.url,
				method: monitor.method ?? "GET",
				codes: [...(monitor.customUpCodes ?? [])].sort((a, b) => a - b),
				locations: [...(monitor.geoCheckLocations ?? [])].sort(),
				enabled: monitor.geoCheckEnabled === true,
			})
		)
		.digest("hex");

export const getGeoCheckState = (monitor: Monitor): GeoCheckState | undefined =>
	monitor.geoCheckEnabled && supportsGeoCheck(monitor.type) && monitor.geoCheckState?.configuration === geoCheckConfiguration(monitor)
		? monitor.geoCheckState
		: undefined;

export const formatGeoLocation = (location: GeoCheckLocation): string =>
	[location.city, location.state, location.country, location.continent].filter(Boolean).join(", ");

export const geoFailureMessage = (failures: GeoCheckFailure[]): string =>
	`Geographic check failed: ${failures.map((failure) => formatGeoLocation(failure.location)).join("; ")}`;

export const mergeGeoObservation = (monitor: Monitor, observation: GeoCheckObservation): GeoCheckState => {
	const previous = getGeoCheckState(monitor);
	const failures = [...(previous?.failures ?? [])];
	for (const continent of monitor.geoCheckLocations ?? []) {
		const results = observation.results.filter((result) => result.location.continent === continent);
		// A missing/offline probe is not evidence of recovery. Any failed probe wins.
		if (!results.length) continue;
		for (let index = failures.length - 1; index >= 0; index--) {
			if (failures[index]?.location.continent === continent) failures.splice(index, 1);
		}
		for (const result of results.filter((result) => !result.status)) {
			failures.push({ location: result.location, statusCode: result.statusCode, checkedAt: observation.checkedAt });
		}
	}
	const outageLocations = [...(previous?.outageLocations ?? [])];
	for (const failure of failures) {
		const index = outageLocations.findIndex((old) => old.location.continent === failure.location.continent);
		if (index >= 0) outageLocations.splice(index, 1);
		outageLocations.push(failure);
	}
	return { configuration: observation.configuration, checkedAt: observation.checkedAt, failures, outageLocations };
};

export const geoCheckToCheck = (monitor: Monitor, geoCheck: GeoCheck): Check => {
	const observation: GeoCheckObservation = {
		configuration: geoCheckConfiguration(monitor),
		checkedAt: geoCheck.createdAt,
		results: geoCheck.results,
	};
	const failed = mergeGeoObservation(monitor, observation).failures;
	const localDown = (monitor.geoCheckLocalStatus ?? monitor.status) === "down";
	return {
		id: geoCheck.id,
		metadata: geoCheck.metadata,
		status: failed.length === 0 && !localDown,
		statusCode: failed[0]?.statusCode ?? (localDown ? NETWORK_ERROR : 200),
		message: failed.length
			? geoFailureMessage(failed)
			: localDown
				? "Geographic checks passed; local monitor remains down"
				: "Geographic checks passed",
		responseTime: Math.max(...geoCheck.results.map((result) => result.timings.total), 0),
		createdAt: geoCheck.createdAt,
		updatedAt: geoCheck.updatedAt,
		geoCheck: observation,
	};
};

// Persist the combined outcome in check history without contaminating the local failure window.
export const applyGeoFailuresToCheck = (check: Check, monitor: Monitor): Check => {
	const failures = getGeoCheckState(monitor)?.failures ?? [];
	if (!monitor.geoCheckEnabled || !supportsGeoCheck(monitor.type)) return check;
	return {
		...check,
		localStatus: check.status,
		...(failures.length
			? {
					status: false,
					statusCode: NETWORK_ERROR,
					message: `${check.status ? "Local check passed. " : `${check.message}. `}${geoFailureMessage(failures)}`,
				}
			: {}),
	};
};
