import type { Monitor } from "@/domain/monitors/monitor.type.js";
import { supportsGeoCheck } from "@/domain/monitors/monitor.type.js";
import { getGeoCheckState } from "@/domain/geo-checks/geo-check.status.js";
import type { PublicGeoHistory } from "./status-page-history.repository.mongo.js";
import type { PublicStatusLocation } from "./status-page.type.js";

export const publicStatusLocations = (monitor: Monitor, history: PublicGeoHistory[], daily: boolean, now: Date): PublicStatusLocation[] => {
	if (!monitor.geoCheckEnabled || !supportsGeoCheck(monitor.type)) return [];
	const state = getGeoCheckState(monitor);
	const interval = monitor.geoCheckInterval ?? 900000;
	return [...new Set(monitor.geoCheckLocations ?? [])].map((continent) => {
		const observations = history.find((row) => row.monitorId === monitor.id && row.continent === continent);
		const latest = observations?.recentChecks.at(-1);
		const failure = state?.failures.find((item) => item.location.continent === continent);
		const checkedAt = failure?.checkedAt ?? latest?.createdAt;
		const stale = !checkedAt || now.getTime() - new Date(checkedAt).getTime() > interval * 2 + 60000;
		const status =
			monitor.status === "paused"
				? "paused"
				: !state?.checkedAt
					? "unknown"
					: failure
						? "down"
						: stale || !latest
							? "unknown"
							: latest.status
								? "up"
								: "down";
		return {
			continent,
			status,
			stale,
			checkedAt,
			interval,
			city: failure?.location.city ?? latest?.city,
			country: failure?.location.country ?? latest?.country,
			recentChecks: observations?.recentChecks ?? [],
			...(daily ? { dailyChecks: observations?.dailyChecks ?? [] } : {}),
		};
	});
};
