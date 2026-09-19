import type { GeoContinent, GeoCheckResult, GeoCheckTimings, GeoCheckLocation } from "@/domain/geo-checks/geo-check.type.js";
import { supportsGeoCheck, type HttpStatusCode } from "@/domain/monitors/monitor.type.js";
import { NETWORK_ERROR } from "@/types/network.js";
import { MonitorType, type HttpMethod } from "@/domain/monitors/monitor.type.js";
import type { ILogger } from "@/utils/logger.js";
import got from "got";
import { isStatusUp } from "@/service/network/utils.js";

const SERVICE_NAME = "GlobalPingService";
const GLOBAL_PING_API_BASE = "https://api.globalping.io/v1";
const POLL_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_SECONDS = 20;
const MAX_POLL_TIMEOUT_MS = (PROBE_TIMEOUT_SECONDS + 10) * 1000; // Allow API finalization after probe timeout.

interface GlobalPingMeasurementRequest {
	type: MonitorType;
	target: string;
	locations: Array<{ continent: GeoContinent; limit: number }>;
	measurementOptions?: { protocol: "HTTP" | "HTTPS"; port: number; request: { method: HttpMethod; path: string; query?: string } };
	timeout: number;
}

interface GlobalPingMeasurementResponse {
	id: string;
	type: string;
	status: "in-progress" | "finished" | "failed";
	probesCount: number;
	results?: GlobalPingProbeResult[];
}

interface GlobalPingProbeResult {
	probe: {
		continent: GeoContinent;
		region: string;
		country: string;
		state: string | null;
		city: string;
		longitude: number;
		latitude: number;
	};
	result: {
		status: "in-progress" | "finished" | "failed" | "offline";
		failureSource?: "target" | "resolver" | "internal";
		statusCode?: number;
		statusCodeName?: string;
		timings?: {
			total: number;
			dns: number;
			tcp: number;
			tls: number;
			firstByte: number;
			download: number;
		};
		stats?: {
			min: number | null;
			max: number | null;
			avg: number | null;
			total: number;
			loss: number;
			rcv: number;
			drop: number;
		};
		rawOutput?: string;
	};
}

export interface IGlobalPingService {
	createMeasurement(monitorType: MonitorType, url: string, locations: GeoContinent[], method?: HttpMethod): Promise<string | null>;
	pollForResults(measurementId: string, timeoutMs?: number, customUpCodes?: HttpStatusCode[]): Promise<GeoCheckResult[]>;
}

export class GlobalPingService implements IGlobalPingService {
	static SERVICE_NAME = SERVICE_NAME;

	private logger: ILogger;

	constructor(
		logger: ILogger,
		private readonly apiToken?: string
	) {
		this.logger = logger;
	}

	async createMeasurement(monitorType: MonitorType, url: string, locations: GeoContinent[], method: HttpMethod = "GET"): Promise<string | null> {
		try {
			if (!supportsGeoCheck(monitorType)) {
				throw new Error(`Unsupported monitor type for GlobalPing: ${monitorType}`);
			}
			const parsedUrl = monitorType === "http" ? new URL(url) : undefined;
			if (parsedUrl && (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password)) {
				throw new Error("Geographic HTTP checks require a public HTTP(S) URL without credentials");
			}
			const cleanTarget = parsedUrl ? parsedUrl.hostname.replace(/^\[|\]$/g, "") : url;
			const uniqueLocations = [...new Set(locations)];
			const requestBody: GlobalPingMeasurementRequest = {
				type: monitorType,
				target: cleanTarget,
				// A per-location limit guarantees one probe per selected continent.
				locations: uniqueLocations.map((continent) => ({ continent, limit: 1 })),
				timeout: PROBE_TIMEOUT_SECONDS,
				...(parsedUrl
					? {
							measurementOptions: {
								protocol: parsedUrl.protocol === "https:" ? ("HTTPS" as const) : ("HTTP" as const),
								port: parsedUrl.port ? Number(parsedUrl.port) : parsedUrl.protocol === "https:" ? 443 : 80,
								request: { method, path: parsedUrl.pathname, ...(parsedUrl.search.slice(1) ? { query: parsedUrl.search.slice(1) } : {}) },
							},
						}
					: {}),
			};

			const response = await got.post<GlobalPingMeasurementResponse>(`${GLOBAL_PING_API_BASE}/measurements`, {
				json: requestBody,
				...(this.apiToken?.trim() ? { headers: { authorization: `Bearer ${this.apiToken.trim()}` } } : {}),
				responseType: "json",
				timeout: { request: 10000 },
			});

			const measurementId = response.body.id;

			this.logger.debug({
				message: `Created GlobalPing measurement: ${measurementId} for target: ${cleanTarget}`,
				service: SERVICE_NAME,
				method: "createMeasurement",
			});

			return measurementId;
		} catch (error: unknown) {
			this.logger.error({
				message: "GlobalPing API unavailable, skipping geo check",
				service: SERVICE_NAME,
				method: "createMeasurement",
				stack: error instanceof Error ? error.stack : undefined,
			});
			return null;
		}
	}

	async pollForResults(
		measurementId: string,
		timeoutMs: number = MAX_POLL_TIMEOUT_MS,
		customUpCodes: HttpStatusCode[] = []
	): Promise<GeoCheckResult[]> {
		const startTime = Date.now();

		while (Date.now() - startTime < timeoutMs) {
			try {
				const response = await got.get<GlobalPingMeasurementResponse>(`${GLOBAL_PING_API_BASE}/measurements/${measurementId}`, {
					responseType: "json",
					timeout: { request: 5000 },
				});

				const measurement = response.body;

				if (measurement.status === "finished") {
					const results = this.transformResults(measurement.results || [], customUpCodes);
					this.logger.debug({
						message: `GlobalPing measurement completed: ${measurementId}`,
						service: SERVICE_NAME,
						method: "pollForResults",
						details: { measurementId, resultsCount: results.length },
					});
					return results;
				}

				if (measurement.status === "failed") {
					this.logger.warn({
						message: `GlobalPing measurement failed: ${measurementId}`,
						service: SERVICE_NAME,
						method: "pollForResults",
					});
					return [];
				}

				// Still in-progress, wait and poll again
				await this.sleep(POLL_INTERVAL_MS);
			} catch (error: unknown) {
				this.logger.error({
					message: "Error polling GlobalPing API",
					service: SERVICE_NAME,
					method: "pollForResults",
					stack: error instanceof Error ? error.stack : undefined,
				});
				return [];
			}
		}

		// Timeout reached
		this.logger.warn({
			message: `GlobalPing measurement polling timeout: ${measurementId}`,
			service: SERVICE_NAME,
			method: "pollForResults",
			details: { measurementId, timeoutMs },
		});
		return [];
	}

	private transformResults(probeResults: GlobalPingProbeResult[], customUpCodes: HttpStatusCode[] = []): GeoCheckResult[] {
		const results: GeoCheckResult[] = [];
		for (const { probe, result } of probeResults) {
			// Globalping identifies target/DNS failures separately from a broken/offline probe.
			// Unknown or incomplete results cannot assert either outage or recovery.
			const targetFailed = result.status === "failed" && (result.failureSource === "target" || result.failureSource === "resolver");
			if (result.status !== "finished" && !targetFailed) continue;
			const location: GeoCheckLocation = { ...probe, state: probe.state ?? "" };
			const timings: GeoCheckTimings = {
				total: result.timings?.total ?? 0,
				dns: result.timings?.dns ?? 0,
				tcp: result.timings?.tcp ?? 0,
				tls: result.timings?.tls ?? 0,
				firstByte: result.timings?.firstByte ?? 0,
				download: result.timings?.download ?? 0,
			};
			if (targetFailed) {
				results.push({ location, status: false, statusCode: NETWORK_ERROR, timings });
			} else if (typeof result.statusCode === "number" && result.statusCode >= 100) {
				results.push({ location, status: isStatusUp(result.statusCode, customUpCodes), statusCode: result.statusCode, timings });
			} else if (result.stats) {
				const { total, rcv, loss, avg } = result.stats;
				if (
					!Number.isInteger(total) ||
					total <= 0 ||
					!Number.isInteger(rcv) ||
					rcv < 0 ||
					rcv > total ||
					typeof loss !== "number" ||
					!Number.isFinite(loss) ||
					loss < 0 ||
					loss > 100
				)
					continue;
				// Partial packet loss is diagnostic evidence, not complete unreachability.
				const up = rcv > 0;
				results.push({
					location,
					status: up,
					statusCode: up ? 200 : NETWORK_ERROR,
					timings: { ...timings, total: avg ?? 0 },
					packetLoss: { sent: total, received: rcv, lost: total - rcv, percent: loss },
				});
			}
		}
		return results;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
