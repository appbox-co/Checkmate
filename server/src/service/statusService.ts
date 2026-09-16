import { geoCheckConfiguration, getGeoCheckState, mergeGeoObservation } from "@/domain/geo-checks/geo-check.status.js";
import { supportsGeoCheck } from "@/domain/monitors/monitor.type.js";
import { IMonitorStatsRepository } from "@/domain/monitor-stats/monitor-stats.repository.interface.js";
import { IMonitorsRepository } from "@/domain/monitors/monitor.repository.interface.js";
import type { Check, CheckDiskInfo } from "@/domain/checks/check.type.js";
import { MonitorStatuses, type Monitor, type MonitorStatus } from "@/domain/monitors/monitor.type.js";
import type {
	DockerStatusPayload,
	GameStatusPayload,
	GrpcStatusPayload,
	HardwareStatusPayload,
	HttpStatusPayload,
	MonitorStatusResponse,
	PageSpeedStatusPayload,
	PingStatusPayload,
	PortStatusPayload,
	StatusChangeResult,
} from "@/types/network.js";
import { AppError } from "@/utils/AppError.js";
import { ILogger } from "@/utils/logger.js";
import type { HardwareStatusMetrics } from "@/types/network.js";
import { MAX_RECENT_CHECKS } from "@/domain/monitors/monitor.type.js";
import { toCheckSnapshot } from "@/domain/checks/check.snapshot.js";

const SERVICE_NAME = "StatusService";
const HARDWARE_ALERT_COUNTER_START = 5;
const HARDWARE_METRIC_KEYS = ["cpu", "memory", "disk", "temp"] as const;
type HardwareMetricKey = (typeof HARDWARE_METRIC_KEYS)[number];
type HardwareBreaches = Record<HardwareMetricKey, boolean>;
type HardwareCounters = Record<HardwareMetricKey, number>;

export interface IStatusService {
	updateRunningStats(monitor: Monitor, networkResponse: MonitorStatusResponse): Promise<boolean>;
	updateMonitorStatus(
		statusResponse: MonitorStatusResponse<
			| PingStatusPayload
			| HttpStatusPayload
			| PageSpeedStatusPayload
			| HardwareStatusPayload
			| DockerStatusPayload
			| PortStatusPayload
			| GameStatusPayload
			| GrpcStatusPayload
			| undefined
		>,
		check: Check,
		monitor: Monitor
	): Promise<StatusChangeResult>;
}

export class StatusService implements IStatusService {
	static SERVICE_NAME = SERVICE_NAME;
	private logger: ILogger;
	private monitorsRepository: IMonitorsRepository;
	private monitorStatsRepository: IMonitorStatsRepository;

	constructor(logger: ILogger, monitorsRepository: IMonitorsRepository, monitorStatsRepository: IMonitorStatsRepository) {
		this.logger = logger;
		this.monitorsRepository = monitorsRepository;
		this.monitorStatsRepository = monitorStatsRepository;
	}

	async updateRunningStats(monitor: Monitor, networkResponse: MonitorStatusResponse) {
		try {
			await this.monitorStatsRepository.updateByMonitorId(monitor.id, {
				status: networkResponse.status === true,
				responseTime: networkResponse.responseTime ?? 0,
				now: Date.now(),
			});
			return true;
		} catch (error: unknown) {
			this.logger.error({
				service: SERVICE_NAME,
				message: error instanceof Error ? error.message : "Unknown error",
				method: "updateRunningStats",
				stack: error instanceof Error ? error.stack : undefined,
			});
			return false;
		}
	}

	private tryUpdateRunningStats = async (monitor: Monitor, statusResponse: MonitorStatusResponse) => {
		const statsOk = await this.updateRunningStats(monitor, statusResponse);
		if (!statsOk) {
			this.logger.warn({
				service: SERVICE_NAME,
				method: "updateMonitorStatus",
				message: `Stats update failed for monitor ${monitor.id}`,
			});
		}
	};

	private computeReachability = (
		currentStatus: MonitorStatus,
		window: Array<boolean>,
		threshold: number
	): { nextStatus: "up" | "down"; transitioned: boolean } => {
		const failures = window.filter((status) => status === false).length;
		const failureRate = (failures / window.length) * 100;

		if (failureRate >= threshold && currentStatus !== "down") {
			return { nextStatus: "down", transitioned: true };
		}

		if (failureRate < threshold && currentStatus === "down") {
			return { nextStatus: "up", transitioned: true };
		}
		return { nextStatus: "up", transitioned: false };
	};

	private computeHardwareStatus = (params: {
		currentStatus: MonitorStatus;
		reachabilityDown: boolean;
		metrics: HardwareStatusMetrics;
		thresholds: { cpu: number; memory: number; disk: number; temp: number };
		counters: HardwareCounters;
	}): {
		nextStatus: MonitorStatus;
		transitioned: boolean;
		breaches: HardwareBreaches;
		nextCounters: HardwareCounters;
	} => {
		const { metrics, thresholds, counters, currentStatus, reachabilityDown } = params;

		const cpuUsage = metrics.cpu?.usage_percent ?? -1;
		const memoryUsage = metrics.memory?.usage_percent ?? -1;
		const temps = metrics.cpu?.temperature ?? [];

		const breaches: HardwareBreaches = {
			cpu: cpuUsage !== -1 && cpuUsage > thresholds.cpu / 100,
			memory: memoryUsage !== -1 && memoryUsage > thresholds.memory / 100,
			disk: metrics.disk
				? metrics.disk.some((d: CheckDiskInfo) => d != null && typeof d.usage_percent === "number" && d.usage_percent > thresholds.disk / 100)
				: false,
			temp: temps.some((temp: number) => temp > thresholds.temp),
		};

		// Update counters: decrement (floored at 0) if breached, reset to start otherwise.
		const nextCounters = { ...counters };
		for (const key of HARDWARE_METRIC_KEYS) {
			nextCounters[key] = breaches[key] ? Math.max(0, counters[key] - 1) : HARDWARE_ALERT_COUNTER_START;
		}

		// Status transition: reachability "down" takes precedence; hardware can only drive
		// transitions into "breached" and back out to "up". Any other case leaves status untouched.
		let nextStatus: MonitorStatus = currentStatus;
		let transitioned = false;

		if (!reachabilityDown) {
			// A counter can only reach zero via the decrement path, which only runs when that
			// metric is currently breaching — so anyCounterZero already implies anyBreached.
			const anyCounterZero = HARDWARE_METRIC_KEYS.some((k) => nextCounters[k] === 0);
			const allNormal = HARDWARE_METRIC_KEYS.every((k) => !breaches[k]);

			if (anyCounterZero && currentStatus !== "breached") {
				nextStatus = "breached";
				transitioned = true;
			} else if (allNormal && currentStatus === "breached") {
				nextStatus = "up";
				transitioned = true;
			}
		}

		return { nextStatus, transitioned, breaches, nextCounters };
	};

	private reminderSchedule = (monitor: Monitor, status: MonitorStatus, statusChanged: boolean): Partial<Monitor> => {
		if (!statusChanged) return {};
		const interval = monitor.notificationReminderInterval ?? 0;
		return {
			// Set the first deadline with the status transition, before the non-blocking
			// notification reactor runs. Recovery clears the previous outage's schedule.
			nextNotificationReminderAt: interval > 0 && (status === "down" || status === "breached") ? Date.now() + interval : 0,
		};
	};

	private updateGeographicStatus = async (statusResponse: MonitorStatusResponse, check: Check, monitor: Monitor): Promise<StatusChangeResult> => {
		const previousState = getGeoCheckState(monitor);
		let state = previousState ?? { configuration: geoCheckConfiguration(monitor), failures: [], outageLocations: [] };
		let localStatus = monitor.geoCheckLocalStatus ?? monitor.status;
		// A pause or maintenance cycle resets the ordinary local window.
		if (monitor.status === "initializing" || monitor.status === "maintenance") localStatus = monitor.status;
		if (check.geoCheck) {
			state = mergeGeoObservation(monitor, check.geoCheck);
		} else {
			const localUp = check.localStatus ?? check.status;
			const window = [...(monitor.statusWindow ?? []), localUp].slice(-monitor.statusWindowSize);
			if (localStatus === "initializing" || localStatus === "maintenance" || !MonitorStatuses.includes(localStatus)) {
				localStatus = localUp ? "up" : "down";
			}
			if (window.length >= monitor.statusWindowSize) {
				localStatus = (window.filter((up) => !up).length / window.length) * 100 >= monitor.statusWindowThreshold ? "down" : "up";
			}
		}
		const nextStatus = state?.failures.length ? "down" : localStatus;
		const changed = nextStatus !== monitor.status && (nextStatus === "down" || monitor.status === "down");
		const recoveredGeoFailures = nextStatus === "up" && monitor.status === "down" ? previousState?.outageLocations : undefined;
		if (state && nextStatus === "up") state = { ...state, outageLocations: [] };
		const patch: Partial<Monitor> = {
			status: nextStatus,
			geoCheckLocalStatus: localStatus,
			...(state ? { geoCheckState: state } : {}),
			...this.reminderSchedule(monitor, nextStatus, changed),
		};
		const combinedUp = !state?.failures.length && (check.geoCheck ? localStatus !== "down" : (check.localStatus ?? check.status));
		await this.tryUpdateRunningStats(monitor, { ...statusResponse, status: combinedUp });
		const updated = check.geoCheck
			? await this.monitorsRepository.updateById(monitor.id, monitor.teamId, patch)
			: await this.monitorsRepository.updateStatusWindowAndChecks(
					monitor.id,
					monitor.teamId,
					check.localStatus ?? check.status,
					toCheckSnapshot({ ...check, status: combinedUp }),
					monitor.statusWindowSize,
					MAX_RECENT_CHECKS,
					patch
				);
		return {
			monitor: updated,
			statusChanged: changed,
			prevStatus: monitor.status,
			code: statusResponse.code,
			timestamp: Date.now(),
			recoveredGeoFailures,
		};
	};

	updateMonitorStatus = async (
		statusResponse: MonitorStatusResponse<
			| PingStatusPayload
			| HttpStatusPayload
			| PageSpeedStatusPayload
			| HardwareStatusPayload
			| DockerStatusPayload
			| PortStatusPayload
			| GameStatusPayload
			| GrpcStatusPayload
			| undefined
		>,
		check: Check,
		monitor: Monitor
	): Promise<StatusChangeResult> => {
		try {
			const { status, code } = statusResponse;
			if (check.geoCheck) {
				const previous = getGeoCheckState(monitor);
				if (
					!monitor.geoCheckEnabled ||
					!supportsGeoCheck(monitor.type) ||
					check.geoCheck.configuration !== geoCheckConfiguration(monitor) ||
					(previous && Date.parse(check.geoCheck.checkedAt) <= Date.parse(previous.checkedAt ?? ""))
				) {
					return { monitor, statusChanged: false, prevStatus: monitor.status, code, timestamp: Date.now(), geoCheckSkipped: true };
				}
			}
			if (supportsGeoCheck(monitor.type) && (monitor.geoCheckEnabled || monitor.geoCheckLocalStatus)) {
				return await this.updateGeographicStatus(statusResponse, check, monitor);
			}

			// Update running stats
			await this.tryUpdateRunningStats(monitor, statusResponse);

			const prevStatus = monitor.status;
			const checkSnapshot = toCheckSnapshot(check);

			// Project the window as it will look after updating DB
			// This is done because we need the updated status window to compute new status, but we don't
			// want an an extra DB write just to get the window.
			const projectedWindow = [...(monitor.statusWindow || []), check.status].slice(-monitor.statusWindowSize);

			// Build the status patch — computed against the projected window
			const patch: Partial<Monitor> = {};

			// Resolve "initializing" and "maintenance" up front, incidents should be created on initialization && down
			// Unknown values (e.g. legacy boolean statuses from old versions) are resolved the same way,
			// otherwise computeReachability can never transition them and they stay stuck forever.
			const isUnknownStatus = !MonitorStatuses.includes(monitor.status);
			let newStatus: MonitorStatus = monitor.status;
			let statusChanged = false;
			if (monitor.status === "initializing" || monitor.status === "maintenance" || isUnknownStatus) {
				newStatus = status ? "up" : "down";
				patch.status = newStatus;
				statusChanged = newStatus === "down";
			}

			// Not enough data points yet — record the check and return
			if (projectedWindow.length < monitor.statusWindowSize) {
				Object.assign(patch, this.reminderSchedule(monitor, newStatus, statusChanged));
				const updated = await this.monitorsRepository.updateStatusWindowAndChecks(
					monitor.id,
					monitor.teamId,
					check.status,
					checkSnapshot,
					monitor.statusWindowSize,
					MAX_RECENT_CHECKS,
					patch
				);

				return {
					monitor: updated,
					statusChanged,
					prevStatus,
					code,
					timestamp: Date.now(),
				};
			}

			// First evaluate reachability status changes, which apply to all monitor types
			// and take precedence over hardware breaches.
			const reachabilityResult = this.computeReachability(newStatus, projectedWindow, monitor.statusWindowThreshold);
			if (reachabilityResult.transitioned) {
				newStatus = reachabilityResult.nextStatus;
				statusChanged = true;
			}

			// Evaluate hardware threshold breaches (only for hardware monitors with metrics payload)
			let thresholdBreaches: HardwareBreaches | undefined;
			const hardwarePayload = statusResponse.payload as HardwareStatusPayload | undefined;
			if (monitor.type === "hardware" && hardwarePayload?.data) {
				const hardware = this.computeHardwareStatus({
					currentStatus: newStatus,
					reachabilityDown: newStatus === "down",
					metrics: hardwarePayload.data,
					thresholds: {
						cpu: monitor.cpuAlertThreshold,
						memory: monitor.memoryAlertThreshold,
						disk: monitor.diskAlertThreshold,
						temp: monitor.tempAlertThreshold,
					},
					counters: {
						cpu: monitor.cpuAlertCounter,
						memory: monitor.memoryAlertCounter,
						disk: monitor.diskAlertCounter,
						temp: monitor.tempAlertCounter,
					},
				});

				patch.cpuAlertCounter = hardware.nextCounters.cpu;
				patch.memoryAlertCounter = hardware.nextCounters.memory;
				patch.diskAlertCounter = hardware.nextCounters.disk;
				patch.tempAlertCounter = hardware.nextCounters.temp;
				thresholdBreaches = hardware.breaches;
				if (hardware.transitioned) {
					newStatus = hardware.nextStatus;
					statusChanged = true;
				}
			}

			patch.status = newStatus;
			Object.assign(patch, this.reminderSchedule(monitor, newStatus, statusChanged));

			// Single atomic write: push arrays + set status/counters
			const updated = await this.monitorsRepository.updateStatusWindowAndChecks(
				monitor.id,
				monitor.teamId,
				check.status,
				checkSnapshot,
				monitor.statusWindowSize,
				MAX_RECENT_CHECKS,
				patch
			);

			return {
				monitor: updated,
				statusChanged,
				prevStatus,
				code,
				timestamp: Date.now(),
				thresholdBreaches,
			};
		} catch (error: unknown) {
			throw new AppError({
				message: `Failed to update monitor with id ${check.metadata.monitorId} with status: ${error instanceof Error ? error.message : "Unknown error"}`,
				service: SERVICE_NAME,
				method: "updateMonitorStatus",
			});
		}
	};
}
