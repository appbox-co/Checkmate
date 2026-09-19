import { geoCheckToCheck, getGeoCheckState } from "@/domain/geo-checks/geo-check.status.js";
import { Monitor } from "@/domain/monitors/monitor.type.js";
import { MonitorEvaluation } from "@/worker/worker.interface.js";
import { IMaintenanceWindowsRepository } from "@/domain/maintenance-windows/maintenance-window.repository.interface.js";
import { isWindowActive } from "@/utils/maintenanceWindow.js";
import { ILogger } from "@/utils/logger.js";
import { IBufferService } from "@/service/bufferService.js";
import { AppError } from "@/utils/AppError.js";
import { supportsGeoCheck } from "@/domain/monitors/monitor.type.js";
import { IGeoChecksService } from "@/domain/geo-checks/geo-check.service.js";

import type { GeoContinent, GeoCheckFailure } from "@/domain/geo-checks/geo-check.type.js";

const SERVICE_NAME = "CheckPipeline";
export const GEO_FAILURE_CONFIRMATION_MS = 60000;

export interface ICheckPipeline {
	run(monitor: Monitor): Promise<MonitorEvaluation | null>; // null = skipped
}

export class GeoChecksPipeline implements ICheckPipeline {
	constructor(
		private maintenanceWindowsRepository: IMaintenanceWindowsRepository,
		private geoChecksService: IGeoChecksService,
		private bufferService: IBufferService,
		private logger: ILogger
	) {}

	private async isInMaintenanceWindow(monitorId: string, teamId: string) {
		const maintenanceWindows = await this.maintenanceWindowsRepository.findByMonitorId(monitorId, teamId);
		const now = new Date();
		return maintenanceWindows.some((window) => isWindowActive(window, now));
	}

	run = async (monitor: Monitor): Promise<MonitorEvaluation | null> => {
		// ****************************
		// Step 1:  Acquire
		// ****************************

		// Step 1a: Guards - skip if unsupported or not enabled

		if (!monitor.id) {
			throw new AppError({ message: "No monitor id", service: SERVICE_NAME, method: "getHeartbeatGeoJob" });
		}

		if (!monitor.geoCheckEnabled || monitor.isActive === false || monitor.status === "paused") {
			return null;
		}
		if (!supportsGeoCheck(monitor.type)) {
			this.logger.debug({
				message: `Monitor ${monitor.id} type does not support geo checks, skipping`,
				service: SERVICE_NAME,
				method: "runGeoChecksPipeline",
			});
			return null;
		}

		if (!monitor.geoCheckLocations || monitor.geoCheckLocations.length === 0) {
			this.logger.warn({
				message: `No geo check locations configured for monitor ${monitor.id}`,
				service: SERVICE_NAME,
				method: "runGeoChecksPipeline",
			});
			return null;
		}

		// Step 1b: Maintenance window check
		const maintenanceWindowActive = await this.isInMaintenanceWindow(monitor.id, monitor.teamId);
		if (maintenanceWindowActive) {
			this.logger.debug({
				message: `Monitor ${monitor.id} is in maintenance window, skipping geo check`,
				service: SERVICE_NAME,
				method: "runGeoChecksPipeline",
			});
			return null;
		}

		// ****************************
		// Step 2: Record
		// ****************************

		const state = getGeoCheckState(monitor);
		const startedAt = new Date(Date.now()).toISOString();
		const lastFullCheckAt = state?.lastFullCheckAt ?? state?.checkedAt;
		const fullCheck = !lastFullCheckAt || Date.now() - Date.parse(lastFullCheckAt) >= (monitor.geoCheckInterval ?? 900000);
		const failedLocations = new Set(state?.failures.map((failure) => failure.location.continent) ?? []);
		const previousPending = new Map((state?.pendingFailures ?? []).map((failure) => [failure.location.continent, failure]));
		const locations = monitor.geoCheckLocations.filter(
			(continent) => fullCheck || failedLocations.has(continent) || state?.pendingLocations?.includes(continent)
		);
		if (!locations.length) return null;

		const geoCheck = await this.geoChecksService.buildGeoCheck(monitor, locations);
		if (!geoCheck) {
			this.logger.warn({
				message: `No geo check could be built for monitor ${monitor.id}`,
				service: SERVICE_NAME,
				method: "runGeoChecksPipeline",
			});
			return null;
		}

		this.bufferService.addGeoCheckToBuffer(geoCheck);
		let results = geoCheck.results.filter((result) => locations.includes(result.location.continent));
		const retryLocations = [
			...new Set(
				results
					.filter((result) => !result.status && !failedLocations.has(result.location.continent) && !previousPending.has(result.location.continent))
					.map((result) => result.location.continent)
			),
		];
		const pendingLocations: GeoContinent[] = [];
		const pendingFailures: GeoCheckFailure[] = [];
		const initialResults = results;
		if (retryLocations.length) {
			// An immediate retry can dismiss a transient failure; it cannot open an outage.
			const retry = await this.geoChecksService.buildGeoCheck(monitor, retryLocations);
			if (retry) this.bufferService.addGeoCheckToBuffer(retry);
			results = results.filter((result) => !retryLocations.includes(result.location.continent));
			for (const continent of retryLocations) {
				const confirmed = retry?.results.filter((result) => result.location.continent === continent) ?? [];
				if (confirmed.length) results.push(...confirmed);
				else {
					pendingLocations.push(continent);
					const first = initialResults.find((result) => !result.status && result.location.continent === continent)!;
					pendingFailures.push({ location: first.location, statusCode: first.statusCode, checkedAt: startedAt });
				}
			}
		}

		// Confirm only on a later acquisition started at least a minute after the first
		// failed acquisition. Provider delays inside one attempt cannot satisfy this.
		results = results.filter((result) => {
			const continent = result.location.continent;
			if (result.status || failedLocations.has(continent)) return true;
			const previous = previousPending.get(continent);
			const firstFailedAt = Date.parse(previous?.checkedAt ?? "");
			if (Number.isFinite(firstFailedAt) && Date.parse(startedAt) - firstFailedAt >= GEO_FAILURE_CONFIRMATION_MS) return true;
			pendingLocations.push(continent);
			pendingFailures.push({
				location: result.location,
				statusCode: result.statusCode,
				checkedAt: Number.isFinite(firstFailedAt) ? previous!.checkedAt : startedAt,
			});
			return false;
		});

		// Timestamp the final decision after the retry so local checks evaluated while
		// waiting cannot cause this observation to be skipped as older history.
		const completedAt = new Date(Date.now()).toISOString();
		this.bufferService.addToBuffer(
			geoCheckToCheck(
				monitor,
				{ ...geoCheck, results, createdAt: completedAt, updatedAt: completedAt },
				{ ...(fullCheck ? { fullCheckAt: startedAt } : { recoveryOnly: true }), pendingLocations, pendingFailures }
			)
		);

		this.logger.debug({
			message: `Geo check job executed for monitor ${monitor.id}`,
			service: SERVICE_NAME,
			method: "runGeoChecksPipeline",
		});
		return null;
	};
}
