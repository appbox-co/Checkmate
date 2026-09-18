import { describe, expect, it } from "@jest/globals";
import { publicStatusLocations } from "../../../src/domain/status-pages/status-page.locations.ts";
import { geoCheckConfiguration } from "../../../src/domain/geo-checks/geo-check.status.ts";
import type { Monitor } from "../../../src/domain/monitors/monitor.type.ts";
import type { PublicGeoHistory } from "../../../src/domain/status-pages/status-page-history.repository.mongo.ts";

const now = new Date("2026-09-18T12:00:00Z");
const monitor = {
	id: "router",
	name: "Router",
	url: "https://example.test",
	type: "http",
	status: "up",
	geoCheckEnabled: true,
	geoCheckInterval: 900000,
	geoCheckLocations: ["EU", "NA", "AS"],
} as Monitor;
monitor.geoCheckState = { configuration: geoCheckConfiguration(monitor), checkedAt: "2026-09-18T11:55:00Z", failures: [], outageLocations: [] };
const history: PublicGeoHistory[] = [
	{
		monitorId: "router",
		continent: "EU",
		recentChecks: [{ createdAt: "2026-09-18T11:55:00Z", status: true, responseTime: 50, city: "London", country: "GB" }],
		dailyChecks: [],
	},
];
describe("public geographic status", () => {
	it("shows fresh real results and leaves missing continents unknown", () => {
		const result = publicStatusLocations(monitor, history, false, now);
		expect(result.map(({ continent, status }) => ({ continent, status }))).toEqual([
			{ continent: "EU", status: "up" },
			{ continent: "NA", status: "unknown" },
			{ continent: "AS", status: "unknown" },
		]);
		expect(result[0]).toMatchObject({ city: "London", stale: false, interval: 900000 });
		expect(result[1]).toMatchObject({ stale: true, recentChecks: [] });
		expect(result[0]).not.toHaveProperty("dailyChecks");
	});
	it("shows an unconfirmed failure as awaiting confirmation, while retaining the diagnostic history", () => {
		const pending = structuredClone(monitor);
		pending.geoCheckState!.pendingLocations = ["EU"];
		expect(publicStatusLocations(pending, history, false, now)[0].status).toBe("unknown");
		const rawFailure = structuredClone(history);
		rawFailure[0].recentChecks[0].status = false;
		const location = publicStatusLocations(monitor, rawFailure, false, now)[0];
		expect(location.status).toBe("unknown");
		expect(location.recentChecks[0].status).toBe(false);
	});

	it("does not carry a green status indefinitely after probes stop returning results", () => {
		expect(publicStatusLocations(monitor, history, true, new Date("2026-09-18T13:00:00Z"))[0]).toMatchObject({
			status: "unknown",
			stale: true,
			dailyChecks: [],
		});
	});
	it("keeps an unresolved regional failure down even when stale or the provider misses that region", () => {
		const failed = structuredClone(monitor);
		failed.geoCheckState!.failures = [
			{ location: { continent: "NA", city: "Dallas", country: "US" } as any, checkedAt: "2026-09-18T10:00:00Z", statusCode: 500 },
		];
		expect(publicStatusLocations(failed, history, false, now)[1]).toMatchObject({ status: "down", stale: true, city: "Dallas" });
	});
	it("treats a changed target configuration as awaiting checks, and paused monitors as paused", () => {
		expect(publicStatusLocations({ ...monitor, url: "https://changed.test" }, history, false, now).every(({ status }) => status === "unknown")).toBe(
			true
		);
		expect(publicStatusLocations({ ...monitor, status: "paused" }, history, false, now).every(({ status }) => status === "paused")).toBe(true);
	});
	it("omits disabled or unsupported probes and only returns selected continents", () => {
		expect(publicStatusLocations({ ...monitor, geoCheckEnabled: false }, history, false, now)).toEqual([]);
		expect(publicStatusLocations({ ...monitor, type: "port" }, history, false, now)).toEqual([]);
		expect(publicStatusLocations({ ...monitor, geoCheckLocations: ["NA"] }, history, false, now).map(({ continent }) => continent)).toEqual(["NA"]);
	});
});
