import { describe, expect, it, jest } from "@jest/globals";
import { StatusPageService } from "../../../src/domain/status-pages/status-page.service.ts";
import type { StatusPage } from "../../../src/domain/status-pages/status-page.type.ts";
import type { Monitor } from "../../../src/domain/monitors/monitor.type.ts";
import type { ISettingsService } from "../../../src/domain/app-settings/app-settings.service.ts";
import type { IStatusPagesRepository } from "../../../src/domain/status-pages/status-page-repository.interface.ts";
import type { IMonitorsRepository } from "../../../src/domain/monitors/monitor.repository.interface.ts";
import type { IMaintenanceWindowsRepository } from "../../../src/domain/maintenance-windows/maintenance-window.repository.interface.ts";
import type { IStatusPageHistoryRepository } from "../../../src/domain/status-pages/status-page-history.repository.mongo.ts";

const page = { teamId: "team", monitors: ["router"], isPublished: true } as StatusPage;
const sample = { id: "failed-ping", status: false, statusCode: 5000, message: "Ping failed", responseTime: 0, createdAt: "2026-09-18T09:00:00Z" };
const monitor = {
	id: "router",
	teamId: "team",
	name: "Router",
	status: "up",
	type: "ping",
	recentChecks: [sample],
	uptimePercentage: 0.9,
} as Monitor;
const createService = () => {
	const history = {
		findHistory: jest.fn().mockResolvedValue({
			intervals: [],
			buckets: [{ monitorId: "router", date: "2026-09-18", totalChecks: 10, upChecks: 10, downChecks: 0, avgResponseTime: 20 }],
		}),
	} as unknown as jest.Mocked<IStatusPageHistoryRepository>;
	const monitors = { findByIds: jest.fn().mockResolvedValue([monitor]) } as unknown as jest.Mocked<IMonitorsRepository>;
	const service = new StatusPageService(
		{} as IStatusPagesRepository,
		{ getDBSettings: async () => ({ showURL: false, checkTTL: 30 }) } as ISettingsService,
		monitors,
		history,
		{ findByMonitorIds: async () => [] } as unknown as IMaintenanceWindowsRepository
	);
	return { service, history, monitors };
};
describe("public status page confirmed history projection", () => {
	it("reports operational history without mutating failed diagnostic checks or inventing latency", async () => {
		const { service } = createService();
		const payload = await service.getPublicStatusPagePayload(page, undefined);
		expect(payload.monitors[0]).toMatchObject({ status: "up", uptimePercentage: 1, recentChecks: [{ id: "failed-ping", status: true }] });
		expect(payload.monitors[0].recentChecks[0].responseTime).toBeUndefined();
		expect(payload.monitors[0].recentChecks[0]).not.toHaveProperty("message");
		expect(payload.monitors[0].recentChecks[0]).not.toHaveProperty("statusCode");
		expect(sample.status).toBe(false);
		expect(monitor.uptimePercentage).toBe(0.9);
	});

	it("shows confirmed outages and derives the percentage from the selected range", async () => {
		const { service, history } = createService();
		history.findHistory.mockResolvedValue({
			intervals: [{ monitorId: "router", start: new Date("2026-09-18T08:00:00Z"), end: null }],
			buckets: [{ monitorId: "router", date: "2026-09-18", totalChecks: 10, upChecks: 7, downChecks: 3, avgResponseTime: 20 }],
		});
		const payload = await service.getPublicStatusPagePayload(page, undefined, "30d");
		expect(payload.monitors[0].uptimePercentage).toBe(0.7);
		expect(payload.monitors[0].recentChecks[0].status).toBe(false);
		expect(payload.monitors[0].dailyChecks?.[0].downChecks).toBe(3);
	});

	it("does not invent 100 percent uptime for a monitor without observations", async () => {
		const { service, history } = createService();
		history.findHistory.mockResolvedValue({ intervals: [], buckets: [] });
		expect((await service.getPublicStatusPagePayload(page, undefined)).monitors[0].uptimePercentage).toBeUndefined();
	});

	it("propagates history lookup failures instead of returning an all-up result", async () => {
		const { service, history } = createService();
		history.findHistory.mockRejectedValue(new Error("history unavailable"));
		await expect(service.getPublicStatusPagePayload(page, undefined)).rejects.toThrow("history unavailable");
	});

	it("only requests history for monitors owned by the page team", async () => {
		const { service, history, monitors } = createService();
		monitors.findByIds.mockResolvedValue([monitor, { ...monitor, id: "foreign", teamId: "other" }]);
		const payload = await service.getPublicStatusPagePayload({ ...page, monitors: ["router", "foreign"] }, undefined);
		expect(payload.monitors).toHaveLength(1);
		expect(history.findHistory).toHaveBeenCalledWith("team", ["router"], undefined, "Etc/UTC", expect.any(Date));
	});
});
