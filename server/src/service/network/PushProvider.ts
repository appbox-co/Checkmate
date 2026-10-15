import { IStatusProvider } from "@/service/network/IStatusProvider.js";
import { DefaultPushGracePeriod, Monitor, MonitorType } from "@/domain/monitors/monitor.type.js";
import { MonitorStatusResponse, NETWORK_ERROR, PushStatusPayload } from "@/types/network.js";

const formatDuration = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
};

// Push monitors make no outbound request. The monitored system calls the push URL,
// which stores lastPushAt; each scheduled check compares its age with the grace period.
export class PushProvider implements IStatusProvider<PushStatusPayload> {
	readonly type = "push";

	// Pushes cannot arrive while Checkmate is stopped. Unless the monitor is already
	// down, silence is measured from process start so a restart cannot raise an alert
	// before the grace period has passed. An existing outage still needs a real push.
	constructor(
		private readonly startedAt: number = Date.now(),
		private readonly now: () => number = Date.now
	) {}

	supports(type: MonitorType) {
		return type === "push";
	}

	async handle(monitor: Monitor): Promise<MonitorStatusResponse<PushStatusPayload>> {
		const now = this.now();
		const gracePeriod = monitor.pushGracePeriod ?? DefaultPushGracePeriod;
		const lastPushAt = monitor.lastPushAt ?? null;
		const createdAt = Date.parse(monitor.createdAt) || 0;
		const reference = Math.max(lastPushAt ?? createdAt, monitor.status === "down" ? 0 : this.startedAt);
		const silentForMs = Math.max(0, now - reference);
		const status = silentForMs <= gracePeriod;
		const message =
			lastPushAt === null
				? status
					? "Waiting for the first push"
					: `No push received within the ${formatDuration(gracePeriod)} grace period`
				: status
					? `Last push ${formatDuration(now - lastPushAt)} ago`
					: `No push for ${formatDuration(now - lastPushAt)} (grace period ${formatDuration(gracePeriod)})`;
		return {
			monitorId: monitor.id,
			teamId: monitor.teamId,
			type: monitor.type,
			status,
			code: status ? 200 : NETWORK_ERROR,
			message,
			responseTime: 0,
			payload: { lastPushAt, silentForMs, gracePeriod },
		};
	}
}
