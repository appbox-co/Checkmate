import { DailyCheckBucket, type CheckSnapshot } from "@/domain/checks/check.type.js";
import type { Monitor } from "@/domain/monitors/monitor.type.js";
export const StatusPageTypes = ["uptime", "infrastructure"] as const;
export type StatusPageType = (typeof StatusPageTypes)[number];

export const StatusPageThemes = ["refined", "modern", "bold", "editorial", "minimal"] as const;
export type StatusPageTheme = (typeof StatusPageThemes)[number];
export const DEFAULT_STATUS_PAGE_THEME: StatusPageTheme = "refined";

export const StatusPageThemeModes = ["auto", "light", "dark"] as const;
export type StatusPageThemeMode = (typeof StatusPageThemeModes)[number];
export const DEFAULT_STATUS_PAGE_THEME_MODE: StatusPageThemeMode = "auto";

export const StatusPageDayRanges = ["30d", "60d", "90d"] as const;
export type StatusPageDayRange = (typeof StatusPageDayRanges)[number];
export const StatusPageRanges = ["latest", ...StatusPageDayRanges] as const;
export type StatusPageRange = (typeof StatusPageRanges)[number];
export const STATUS_PAGE_RANGE_DAYS: Record<StatusPageDayRange, number> = {
	"30d": 30,
	"60d": 60,
	"90d": 90,
};
export interface StatusPageLogo {
	data: string;
	contentType: string;
}

export interface StatusPageLogoDocument {
	data: Buffer;
	contentType: string;
}

export const StatusUpdateStates = ["announcement", "investigating", "identified", "monitoring", "resolved"] as const;
export type StatusUpdateState = (typeof StatusUpdateStates)[number];
export const MAX_STATUS_PAGE_UPDATES = 200;

export interface StatusPageUpdateInput {
	title: string;
	body: string;
	status: StatusUpdateState;
	pinned: boolean;
}

export interface StatusPageUpdate extends StatusPageUpdateInput {
	id: string;
	author: string;
	createdAt: string;
	updatedAt: string;
}

export interface PublicMaintenanceWindow {
	id: string;
	name: string;
	start: string;
	end: string;
	repeat: number;
	status: "scheduled" | "in_progress";
	monitors: { id: string; name: string }[];
}

export interface StatusPage {
	updates?: StatusPageUpdate[];
	id: string;
	userId: string;
	teamId: string;
	type: StatusPageType[];
	companyName: string;
	url: string;
	customDomain?: string | null;
	timezone?: string;
	color: string;
	monitors: string[];
	subMonitors: string[];
	originalMonitors?: string[];
	logo?: StatusPageLogo | null;
	isPublished: boolean;
	showCharts: boolean;
	showUptimePercentage: boolean;
	showAdminLoginLink: boolean;
	showInfrastructure: boolean;
	customCSS: string;
	theme: StatusPageTheme;
	themeMode: StatusPageThemeMode;
	createdAt: string;
	updatedAt: string;
}

export interface PublicLocationSample {
	createdAt: string;
	status: boolean;
	responseTime?: number;
	city: string;
	country: string;
}
export interface PublicStatusLocation {
	continent: string;
	status: "up" | "down" | "unknown" | "paused";
	stale: boolean;
	checkedAt?: string;
	interval: number;
	city?: string;
	country?: string;
	recentChecks: PublicLocationSample[];
	dailyChecks?: DailyCheckBucket[];
}
export interface PublicOutage {
	id: string;
	startTime: string;
	endTime: string | null;
	statusCode: number | null;
}
export interface PublicOutagePage {
	events: PublicOutage[];
	page: number;
	hasMore: boolean;
}
export interface PublicMonitorSelection {
	monitorId?: string;
	incidentPage?: number;
}
export type PublicStatusPageMonitor = Pick<Monitor, "id" | "name" | "type" | "status" | "uptimePercentage" | "interval"> & {
	locations?: PublicStatusLocation[];
	recentChecks: (Omit<CheckSnapshot, "message" | "statusCode" | "responseTime"> & { responseTime?: number })[];
	url?: string;
	port?: number;
	dailyChecks?: DailyCheckBucket[]; // Only present when range !== "latest"
};

export interface PublicStatusPagePayload {
	outages?: PublicOutagePage;
	statusPage: StatusPage;
	monitors: PublicStatusPageMonitor[];
	maintenanceWindows: PublicMaintenanceWindow[];
	range?: StatusPageDayRange;
	bucketTimezone?: string;
	checkTTLDays?: number;
}
