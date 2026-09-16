import { describe, expect, it } from "@jest/globals";
import { publicMaintenanceWindow } from "../../../src/domain/status-pages/public-maintenance.ts";
import type { MaintenanceWindow } from "../../../src/domain/maintenance-windows/maintenance-window.type.ts";
import { isWindowActive } from "../../../src/utils/maintenanceWindow.ts";

const monitors = [{ id: "public", name: "API", url: "private-url" }];
const start = Date.parse("2026-10-24T01:00:00Z");
const hour = 3600000;
const window = (patch: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({
	id: "window",
	teamId: "team",
	active: true,
	name: "Database upgrade",
	monitorIds: ["public", "private"],
	start: new Date(start).toISOString(),
	end: new Date(start + hour).toISOString(),
	repeat: 0,
	duration: 1,
	durationUnit: "hours",
	createdAt: "",
	updatedAt: "",
	...patch,
});

describe("public maintenance schedule", () => {
	it("shows future and active one-off maintenance, then removes it after the inclusive end", () => {
		expect(publicMaintenanceWindow(window(), monitors, new Date(start - 1))?.status).toBe("scheduled");
		for (const time of [start, start + hour / 2, start + hour]) {
			expect(publicMaintenanceWindow(window(), monitors, new Date(time))?.status).toBe("in_progress");
		}
		expect(publicMaintenanceWindow(window(), monitors, new Date(start + hour + 1))).toBeNull();
	});
	it("exposes only selected service names and public schedule fields", () => {
		expect(publicMaintenanceWindow(window(), monitors, new Date(start))).toEqual({
			id: "window",
			name: "Database upgrade",
			start: new Date(start).toISOString(),
			end: new Date(start + hour).toISOString(),
			repeat: 0,
			status: "in_progress",
			monitors: [{ id: "public", name: "API" }],
		});
		expect(publicMaintenanceWindow(window({ monitorIds: ["private"] }), monitors, new Date(start))).toBeNull();
		expect(publicMaintenanceWindow(window({ active: false }), monitors, new Date(start))).toBeNull();
	});
	it.each([24 * hour, 7 * 24 * hour])("advances recurring windows and agrees with the scheduler at boundaries (%s ms)", (repeat) => {
		const recurring = window({ repeat });
		for (const cycle of [1, 3, 1000]) {
			for (const offset of [-1, 0, hour, hour + 1]) {
				const now = new Date(start + repeat * cycle + offset);
				const actual = publicMaintenanceWindow(recurring, monitors, now)!;
				expect(actual.status === "in_progress").toBe(isWindowActive(recurring, now));
				expect(Date.parse(actual.end)).toBeGreaterThanOrEqual(now.getTime());
				expect(Date.parse(actual.end) - Date.parse(actual.start)).toBe(hour);
			}
		}
	});
	it("retains fixed elapsed-time recurrence across daylight-saving changes", () => {
		const result = publicMaintenanceWindow(window({ repeat: 24 * hour }), monitors, new Date("2026-10-25T01:30:00Z"));
		expect(result).toMatchObject({ start: "2026-10-25T01:00:00.000Z", end: "2026-10-25T02:00:00.000Z", status: "in_progress" });
	});
	it("handles overlapping occurrences consistently", () => {
		const recurring = window({ repeat: hour / 2 });
		expect(publicMaintenanceWindow(recurring, monitors, new Date(start + 10 * hour))?.status).toBe("in_progress");
	});
	it.each([{ start: "invalid" }, { end: "invalid" }, { repeat: -1 }, { end: new Date(start - 1).toISOString() }])(
		"omits malformed persisted windows: %j",
		(patch) => {
			expect(publicMaintenanceWindow(window(patch), monitors, new Date(start))).toBeNull();
		}
	);
});
