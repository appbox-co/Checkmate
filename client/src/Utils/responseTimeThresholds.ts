// Per-monitor response-time display bands (ms). Display only: response time never
// affects status, incidents or alerts. A single configured value keeps the default
// 1:2 ratio between the medium and slow limits.
export interface ResponseTimeThresholds {
	medium: number; // above this a response is medium
	slow: number; // above this a response is slow
}

export const STATUS_PAGE_RESPONSE_TIME_THRESHOLDS: ResponseTimeThresholds = {
	medium: 250,
	slow: 500,
};

export const resolveResponseTimeThresholds = (monitor?: {
	responseTimeMediumThreshold?: number | null;
	responseTimeSlowThreshold?: number | null;
}): ResponseTimeThresholds | undefined => {
	const medium = monitor?.responseTimeMediumThreshold ?? undefined;
	const slow = monitor?.responseTimeSlowThreshold ?? undefined;
	if (medium === undefined && slow === undefined) return undefined;
	if (slow === undefined) return { medium: medium!, slow: medium! * 2 };
	if (medium === undefined) return { medium: Math.round(slow / 2), slow };
	return { medium, slow };
};
