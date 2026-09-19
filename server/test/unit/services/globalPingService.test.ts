import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";
import { createMockLogger } from "../../helpers/createMockLogger.ts";
import type { GeoContinent } from "../../../src/domain/geo-checks/geo-check.type.ts";

// ── got mock ─────────────────────────────────────────────────────────────────

const mockGotPost = jest.fn();
const mockGotGet = jest.fn();

jest.unstable_mockModule("got", () => ({
	default: {
		post: mockGotPost,
		get: mockGotGet,
	},
}));

// Dynamic import AFTER mock registration
const { GlobalPingService } = await import("../../../src/service/globalPingService.ts");

// ── Helpers ──────────────────────────────────────────────────────────────────

const createService = () => {
	const logger = createMockLogger();
	const service = new GlobalPingService(logger as any);
	return { service, logger };
};

const makeProbeResult = (overrides?: Record<string, any>) => ({
	probe: {
		continent: "NA" as GeoContinent,
		region: "Northern America",
		country: "US",
		state: "CA",
		city: "San Francisco",
		longitude: -122.4,
		latitude: 37.77,
	},
	result: {
		status: "finished",
		statusCode: 200,
		statusCodeName: "OK",
		timings: {
			total: 150,
			dns: 10,
			tcp: 20,
			tls: 30,
			firstByte: 50,
			download: 40,
		},
	},
	...overrides,
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GlobalPingService", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockGotPost.mockReset();
		mockGotGet.mockReset();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	// ── Static / instance properties ─────────────────────────────────────

	// ── createMeasurement ────────────────────────────────────────────────

	describe("createMeasurement", () => {
		it("creates a measurement and returns the id", async () => {
			const { service, logger } = createService();
			mockGotPost.mockResolvedValue({ body: { id: "meas-123" } });

			const result = await service.createMeasurement("http", "https://example.com", ["NA", "EU"] as GeoContinent[]);

			expect(result).toBe("meas-123");
			expect(mockGotPost).toHaveBeenCalledWith(
				"https://api.globalping.io/v1/measurements",
				expect.objectContaining({
					json: {
						type: "http",
						target: "example.com",
						locations: [
							{ continent: "NA", limit: 1 },
							{ continent: "EU", limit: 1 },
						],
						measurementOptions: { protocol: "HTTPS", port: 443, request: { method: "GET", path: "/" } },
						timeout: 20,
					},
					responseType: "json",
					timeout: { request: 10000 },
				})
			);
			expect(logger.debug).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining("meas-123"),
					method: "createMeasurement",
				})
			);
		});

		it("uses the account token only to authorize measurement creation", async () => {
			const logger = createMockLogger();
			const token = "globalping-test-token";
			const service = new GlobalPingService(logger as any, token);
			mockGotPost.mockResolvedValue({ body: { id: "meas-auth" } });
			mockGotGet.mockResolvedValue({ body: { status: "finished", results: [makeProbeResult()] } });
			await service.createMeasurement("ping", "example.com", ["EU"]);
			await service.pollForResults("meas-auth");
			expect(mockGotPost.mock.calls[0][1].headers).toEqual({ authorization: `Bearer ${token}` });
			expect(JSON.stringify(mockGotPost.mock.calls[0][1].json)).not.toContain(token);
			expect(mockGotGet.mock.calls[0][1]).not.toHaveProperty("headers");
			expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(token);
		});

		it.each([undefined, ""])("keeps requests anonymous without a token (%s)", async (token) => {
			const service = new GlobalPingService(createMockLogger() as any, token);
			mockGotPost.mockResolvedValue({ body: { id: "meas-anonymous" } });
			await service.createMeasurement("ping", "example.com", ["EU"]);
			expect(mockGotPost.mock.calls[0][1]).not.toHaveProperty("headers");
		});

		it("strips http:// protocol from target URL", async () => {
			const { service } = createService();
			mockGotPost.mockResolvedValue({ body: { id: "meas-1" } });

			await service.createMeasurement("http", "http://example.com", ["NA"] as GeoContinent[]);

			expect(mockGotPost).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					json: expect.objectContaining({ target: "example.com" }),
				})
			);
		});

		it("preserves HTTP paths without sending an empty query string", async () => {
			const { service } = createService();
			mockGotPost.mockResolvedValue({ body: { id: "meas-1" } });

			await service.createMeasurement("http", "https://example.com/path", ["EU"] as GeoContinent[]);

			expect(mockGotPost).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					json: expect.objectContaining({
						target: "example.com",
						measurementOptions: { protocol: "HTTPS", port: 443, request: { method: "GET", path: "/path" } },
					}),
				})
			);
		});

		it("returns null and logs error for unsupported monitor type", async () => {
			const { service, logger } = createService();

			const result = await service.createMeasurement("hardware" as any, "https://example.com", ["NA"] as GeoContinent[]);

			expect(result).toBeNull();
			expect(logger.error).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "GlobalPing API unavailable, skipping geo check",
					method: "createMeasurement",
				})
			);
		});

		it("returns null and logs error when API call fails", async () => {
			const { service, logger } = createService();
			mockGotPost.mockRejectedValue(new Error("Network error"));

			const result = await service.createMeasurement("http", "https://example.com", ["NA"] as GeoContinent[]);

			expect(result).toBeNull();
			expect(logger.error).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "GlobalPing API unavailable, skipping geo check",
					method: "createMeasurement",
				})
			);
		});

		it("logs stack as undefined for non-Error thrown values", async () => {
			const { service, logger } = createService();
			mockGotPost.mockRejectedValue("string error");

			await service.createMeasurement("http", "https://example.com", ["NA"] as GeoContinent[]);

			expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stack: undefined }));
		});

		it("supports ping monitor type", async () => {
			const { service } = createService();
			mockGotPost.mockResolvedValue({ body: { id: "meas-ping" } });

			const result = await service.createMeasurement("ping", "example.com", ["NA"] as GeoContinent[]);

			expect(result).toBe("meas-ping");
		});
	});

	// ── pollForResults ───────────────────────────────────────────────────

	describe("pollForResults", () => {
		it("returns transformed results when measurement is finished", async () => {
			const { service, logger } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [makeProbeResult()],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results).toHaveLength(1);
			expect(results[0]).toEqual(
				expect.objectContaining({
					location: expect.objectContaining({
						continent: "NA",
						city: "San Francisco",
					}),
					status: true,
					statusCode: 200,
					timings: expect.objectContaining({
						total: 150,
						dns: 10,
					}),
				})
			);
			expect(logger.debug).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining("meas-123"),
					method: "pollForResults",
				})
			);
		});

		it("defaults results to empty array when finished with no results", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: { status: "finished", results: undefined },
			});

			const results = await service.pollForResults("meas-123");

			expect(results).toEqual([]);
		});

		it("returns empty array when measurement has failed", async () => {
			const { service, logger } = createService();
			mockGotGet.mockResolvedValue({
				body: { status: "failed" },
			});

			const results = await service.pollForResults("meas-123");

			expect(results).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining("failed"),
					method: "pollForResults",
				})
			);
		});

		it("polls again when status is in-progress, then returns on finished", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValueOnce({ body: { status: "in-progress" } }).mockResolvedValueOnce({
				body: {
					status: "finished",
					results: [makeProbeResult()],
				},
			});

			const promise = service.pollForResults("meas-123");

			// Advance past the sleep(2000)
			await jest.advanceTimersByTimeAsync(2000);

			const results = await promise;

			expect(mockGotGet).toHaveBeenCalledTimes(2);
			expect(results).toHaveLength(1);
		});

		it("returns empty array and logs error when API call throws", async () => {
			const { service, logger } = createService();
			mockGotGet.mockRejectedValue(new Error("Connection refused"));

			const results = await service.pollForResults("meas-123");

			expect(results).toEqual([]);
			expect(logger.error).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Error polling GlobalPing API",
					method: "pollForResults",
				})
			);
		});

		it("logs stack as undefined for non-Error thrown values in poll", async () => {
			const { service, logger } = createService();
			mockGotGet.mockRejectedValue(42);

			await service.pollForResults("meas-123");

			expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stack: undefined }));
		});

		it("returns empty array and logs warning on timeout", async () => {
			const { service, logger } = createService();
			// Always return in-progress so we hit the timeout
			mockGotGet.mockImplementation(async () => ({ body: { status: "in-progress" } }));

			const promise = service.pollForResults("meas-123", 100);

			// Advance time well past the timeout
			await jest.advanceTimersByTimeAsync(35000);

			const results = await promise;

			expect(results).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining("timeout"),
					method: "pollForResults",
					details: expect.objectContaining({ measurementId: "meas-123", timeoutMs: 100 }),
				})
			);
		});
	});

	// ── transformResults (via pollForResults) ────────────────────────────

	describe("geographic outage observations", () => {
		it.each(["target", "resolver"])("retains %s failures, including connection and DNS timeouts", async (failureSource) => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({ body: { status: "finished", results: [makeProbeResult({ result: { status: "failed", failureSource } })] } });
			expect(await service.pollForResults("failure")).toEqual([
				expect.objectContaining({ status: false, statusCode: 5000, location: expect.objectContaining({ city: "San Francisco" }) }),
			]);
		});
		it.each([
			{ status: "offline" },
			{ status: "in-progress" },
			{ status: "failed", failureSource: "internal" },
			{ status: "failed" },
			{ status: "finished", stats: { loss: null, total: 3 } },
			{ status: "finished", stats: { loss: 0, total: 0 } },
		])("ignores inconclusive probe result %j", async (result) => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({ body: { status: "finished", results: [makeProbeResult({ result })] } });
			expect(await service.pollForResults("unknown")).toEqual([]);
		});
		it("accepts a configured HTTP status without timings", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({ body: { status: "finished", results: [makeProbeResult({ result: { status: "finished", statusCode: 401 } })] } });
			expect((await service.pollForResults("custom", undefined, [401]))[0]).toMatchObject({ status: true, statusCode: 401, timings: { total: 0 } });
		});
		it("preserves HTTPS, path, query, port and the configured method with one probe per continent", async () => {
			const { service } = createService();
			mockGotPost.mockResolvedValue({ body: { id: "method" } });
			await service.createMeasurement("http", "https://example.com:8443/v1/jobs?health=1#ignored", ["EU", "NA", "EU"], "HEAD");
			expect(mockGotPost).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					json: {
						type: "http",
						target: "example.com",
						locations: [
							{ continent: "EU", limit: 1 },
							{ continent: "NA", limit: 1 },
						],
						timeout: 20,
						measurementOptions: { protocol: "HTTPS", port: 8443, request: { method: "HEAD", path: "/v1/jobs", query: "health=1" } },
					},
				})
			);
		});
		it("does not publish URL credentials to Globalping", async () => {
			const { service } = createService();
			expect(await service.createMeasurement("http", "https://user:secret@example.com", ["EU"])).toBeNull();
			expect(mockGotPost).not.toHaveBeenCalled();
		});
	});

	describe("transformResults", () => {
		it("skips probes with non-finished status", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [makeProbeResult({ result: { status: "failed" } }), makeProbeResult({ result: { status: "timeout" } })],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results).toEqual([]);
		});

		it("transforms HTTP results with statusCode and timings", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [makeProbeResult()],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results[0].status).toBe(true);
			expect(results[0].statusCode).toBe(200);
			expect(results[0].timings.total).toBe(150);
		});

		it("marks HTTP result as failed for non-2xx status codes", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [
						makeProbeResult({
							result: {
								status: "finished",
								statusCode: 500,
								timings: { total: 100, dns: 5, tcp: 10, tls: 15, firstByte: 30, download: 40 },
							},
						}),
					],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results[0].status).toBe(false);
			expect(results[0].statusCode).toBe(500);
		});

		it("transforms ping results with stats (no loss)", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [
						makeProbeResult({
							result: {
								status: "finished",
								stats: { min: 10, max: 30, avg: 20, total: 3, loss: 0, rcv: 3, drop: 0 },
							},
						}),
					],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results[0].status).toBe(true);
			expect(results[0].statusCode).toBe(200);
			expect(results[0].timings.total).toBe(20);
			expect(results[0].timings.dns).toBe(0);
		});

		it.each([1, 2, 3])("keeps a ping with %i of three replies up and records packet loss", async (received) => {
			const { service } = createService();
			const loss = ((3 - received) / 3) * 100;
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [
						makeProbeResult({
							result: {
								status: "finished",
								stats: { min: 250, max: 270, avg: 262.833, total: 3, loss, rcv: received, drop: 3 - received },
							},
						}),
					],
				},
			});
			const [result] = await service.pollForResults("partial-loss");
			expect(result).toMatchObject({
				status: true,
				statusCode: 200,
				timings: { total: 262.833 },
				packetLoss: { sent: 3, received, lost: 3 - received, percent: loss },
			});
		});

		it("marks a ping down only when no packets received a reply", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [
						makeProbeResult({
							result: {
								status: "finished",
								stats: { min: null, max: null, avg: null, total: 3, loss: 100, rcv: 0, drop: 3 },
							},
						}),
					],
				},
			});
			expect(await service.pollForResults("no-replies")).toEqual([
				expect.objectContaining({
					status: false,
					statusCode: 5000,
					timings: expect.objectContaining({ total: 0 }),
					packetLoss: { sent: 3, received: 0, lost: 3, percent: 100 },
				}),
			]);
		});

		it.each([
			{ total: 3, rcv: undefined, loss: 100 },
			{ total: 3, rcv: -1, loss: 100 },
			{ total: 3, rcv: 4, loss: 0 },
			{ total: 3, rcv: 0.5, loss: 50 },
			{ total: 0, rcv: 0, loss: 100 },
			{ total: 3, rcv: 0, loss: Number.NaN },
			{ total: 3, rcv: 0, loss: 101 },
		])("ignores inconclusive ping statistics %j", async (stats) => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({ body: { status: "finished", results: [makeProbeResult({ result: { status: "finished", stats } })] } });
			expect(await service.pollForResults("invalid-statistics")).toEqual([]);
		});

		it("uses empty string for null state in location", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [
						makeProbeResult({
							probe: {
								continent: "EU",
								region: "Western Europe",
								country: "DE",
								state: null,
								city: "Berlin",
								longitude: 13.4,
								latitude: 52.5,
							},
						}),
					],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results[0].location.state).toBe("");
		});

		it("skips probes with no statusCode/timings and no stats", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [
						makeProbeResult({
							result: { status: "finished" },
						}),
					],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results).toEqual([]);
		});

		it("transforms multiple probes from different locations", async () => {
			const { service } = createService();
			mockGotGet.mockResolvedValue({
				body: {
					status: "finished",
					results: [
						makeProbeResult(),
						makeProbeResult({
							probe: {
								continent: "EU",
								region: "Western Europe",
								country: "GB",
								state: null,
								city: "London",
								longitude: -0.12,
								latitude: 51.5,
							},
							result: {
								status: "finished",
								statusCode: 200,
								timings: { total: 80, dns: 5, tcp: 10, tls: 15, firstByte: 30, download: 20 },
							},
						}),
					],
				},
			});

			const results = await service.pollForResults("meas-123");

			expect(results).toHaveLength(2);
			expect(results[0].location.continent).toBe("NA");
			expect(results[1].location.continent).toBe("EU");
		});
	});
});
