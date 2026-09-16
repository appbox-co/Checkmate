import type { MaintenanceWindow } from "@/domain/maintenance-windows/maintenance-window.type.js";
import type { PublicMaintenanceWindow } from "./status-page.type.js";

// Match the scheduler's inclusive end and fixed millisecond recurrence. Return the
// earliest occurrence that has not ended, without looping through historical repeats.
export const publicMaintenanceWindow = (
	window: MaintenanceWindow,
	monitors: { id: string; name: string }[],
	now = new Date()
): PublicMaintenanceWindow | null => {
	if (!window.active) return null;
	const affected = monitors.filter(({ id }) => window.monitorIds.includes(id));
	if (!affected.length) return null;
	const start = Date.parse(window.start);
	const end = Date.parse(window.end);
	const time = now.getTime();
	if (![start, end, time, window.repeat].every(Number.isFinite) || end <= start || window.repeat < 0) return null;
	if (window.repeat === 0 && end < time) return null;
	const cycles = window.repeat > 0 ? Math.max(0, Math.ceil((time - end) / window.repeat)) : 0;
	const nextStart = new Date(start + cycles * window.repeat);
	const nextEnd = new Date(end + cycles * window.repeat);
	if (!Number.isFinite(nextStart.getTime()) || !Number.isFinite(nextEnd.getTime())) return null;
	return {
		id: window.id,
		name: window.name,
		start: nextStart.toISOString(),
		end: nextEnd.toISOString(),
		repeat: window.repeat,
		status: nextStart.getTime() <= time ? "in_progress" : "scheduled",
		monitors: affected.map(({ id, name }) => ({ id, name })),
	};
};
