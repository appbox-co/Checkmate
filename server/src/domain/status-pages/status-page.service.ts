import { publicStatusLocations } from "./status-page.locations.js";
import type { PublicMonitorSelection } from "./status-page.type.js";
import { supportsGeoCheck } from "@/domain/monitors/monitor.type.js";
import { isConfirmedDown, type IStatusPageHistoryRepository, type PublicStatusHistory } from "./status-page-history.repository.mongo.js";
import { randomUUID } from "node:crypto";
import type { IMaintenanceWindowsRepository } from "@/domain/maintenance-windows/maintenance-window.repository.interface.js";
import { publicMaintenanceWindow } from "./public-maintenance.js";
import type { StatusPageUpdateInput } from "./status-page.type.js";
import { type IStatusPagesRepository } from "@/domain/status-pages/status-page-repository.interface.js";
import { ISettingsService } from "@/domain/app-settings/app-settings.service.js";
import { IMonitorsRepository } from "@/domain/monitors/monitor.repository.interface.js";
import {
	DEFAULT_STATUS_PAGE_THEME,
	DEFAULT_STATUS_PAGE_THEME_MODE,
	PublicStatusPagePayload,
	STATUS_PAGE_RANGE_DAYS,
	StatusPage,
	StatusPageRange,
} from "@/domain/status-pages/status-page.type.js";
import { AppError } from "@/utils/AppError.js";
import { normalizeStatusPageDomain } from "@/utils/statusPageDomain.js";
import { Monitor } from "@/domain/monitors/monitor.type.js";
import type { DailyCheckBucket } from "@/domain/checks/check.type.js";

export interface IStatusPageService {
	createStatusPage(userId: string, teamId: string, image: Express.Multer.File | undefined, data: Partial<StatusPage>): Promise<StatusPage>;
	getStatusPageByUrl(url: string): Promise<StatusPage>;
	getStatusPageByCustomDomain(customDomain: string): Promise<StatusPage>;
	getStatusPagesByTeamId(teamId: string): Promise<StatusPage[]>;
	getPublicStatusPagePayload(
		statusPage: StatusPage,
		requesterTeamId: string | undefined,
		range: StatusPageRange,
		selection?: PublicMonitorSelection
	): Promise<PublicStatusPagePayload>;
	updateStatusPage(id: string, teamId: string, image: Express.Multer.File | undefined, data: Partial<StatusPage>): Promise<StatusPage>;

	addStatusUpdate(id: string, teamId: string, author: string, data: StatusPageUpdateInput): Promise<StatusPage>;
	editStatusUpdate(id: string, teamId: string, updateId: string, data: StatusPageUpdateInput): Promise<StatusPage>;
	deleteStatusUpdate(id: string, teamId: string, updateId: string): Promise<StatusPage>;
	deleteStatusPage(statusPageId: string, teamId: string): Promise<StatusPage>;
}

export class StatusPageService implements IStatusPageService {
	constructor(
		private statusPagesRepository: IStatusPagesRepository,
		private settingsService: ISettingsService,
		private monitorsRepository: IMonitorsRepository,
		private historyRepository: IStatusPageHistoryRepository,
		private maintenanceWindowsRepository: IMaintenanceWindowsRepository
	) {}

	private assertCustomDomainAllowed = (customDomain: string | null | undefined) => {
		if (!customDomain) {
			return;
		}

		const clientHost = normalizeStatusPageDomain(this.settingsService.getSettings().clientHost);
		if (clientHost && customDomain === clientHost) {
			throw new AppError({
				message: "Custom domain cannot match the Checkmate instance host",
				status: 400,
			});
		}
	};

	private normalizeCustomDomainInput = (data: Partial<StatusPage>): Partial<StatusPage> => {
		if (!("customDomain" in data)) {
			return data;
		}

		const customDomain = normalizeStatusPageDomain(data.customDomain);
		this.assertCustomDomainAllowed(customDomain);
		return { ...data, customDomain };
	};

	private withoutThemeFields = (data: Partial<StatusPage>): Partial<StatusPage> => {
		const { theme: _theme, themeMode: _themeMode, ...rest } = data;
		return rest;
	};

	private applyDefaultTheme = (statusPage: StatusPage): StatusPage => ({
		...statusPage,
		theme: DEFAULT_STATUS_PAGE_THEME,
		themeMode: DEFAULT_STATUS_PAGE_THEME_MODE,
	});

	private normalizeTheme = (statusPage: StatusPage): StatusPage =>
		this.settingsService.areStatusPageThemesEnabled() ? statusPage : this.applyDefaultTheme(statusPage);

	private normalizeInput = (data: Partial<StatusPage>): Partial<StatusPage> =>
		this.settingsService.areStatusPageThemesEnabled() ? data : this.withoutThemeFields(data);

	private toPublicMonitor = (monitor: Monitor, showURL: boolean, history: PublicStatusHistory) => {
		const buckets = history.buckets.filter((bucket) => bucket.monitorId === monitor.id);
		const totalChecks = buckets.reduce((total, bucket) => total + bucket.totalChecks, 0);
		const upChecks = buckets.reduce((total, bucket) => total + bucket.upChecks, 0);
		const base = {
			id: monitor.id,
			name: monitor.name,
			type: monitor.type,
			status: monitor.status,
			interval: monitor.interval,
			uptimePercentage: totalChecks ? upChecks / totalChecks : undefined,
			recentChecks: monitor.recentChecks.map((check) => {
				const { message: _message, statusCode: _statusCode, ...sample } = check;
				return {
					...sample,
					status: !isConfirmedDown(history.intervals, monitor.id, check.createdAt),
					responseTime: check.status ? check.responseTime : undefined,
				};
			}),
		};

		if (showURL) {
			return {
				...base,
				url: monitor.url,
				port: monitor.port,
			};
		}
		return base;
	};

	createStatusPage = async (
		userId: string,
		teamId: string,
		image: Express.Multer.File | undefined,
		data: Partial<StatusPage>
	): Promise<StatusPage> => {
		const normalizedData = this.normalizeCustomDomainInput(this.normalizeInput(data));
		const created = await this.statusPagesRepository.create(userId, teamId, image, normalizedData);
		return this.normalizeTheme(created);
	};

	getStatusPageByUrl = async (url: string): Promise<StatusPage> => {
		const statusPage = await this.statusPagesRepository.findByUrl(url);
		return this.normalizeTheme(statusPage);
	};

	getStatusPageByCustomDomain = async (customDomain: string): Promise<StatusPage> => {
		const statusPage = await this.statusPagesRepository.findByCustomDomain(customDomain);
		return this.normalizeTheme(statusPage);
	};

	getStatusPagesByTeamId = async (teamId: string): Promise<StatusPage[]> => {
		const statusPages = await this.statusPagesRepository.findByTeamId(teamId);
		return statusPages.map((sp) => this.normalizeTheme(sp));
	};

	getPublicStatusPagePayload = async (
		statusPage: StatusPage,
		requesterTeamId: string | undefined,
		range: StatusPageRange = "latest",
		selection: PublicMonitorSelection = {}
	): Promise<PublicStatusPagePayload> => {
		if (!statusPage.isPublished) {
			if (!requesterTeamId || statusPage.teamId !== requesterTeamId) {
				throw new AppError({ message: "Forbidden", status: 403 });
			}
		}

		if (selection.monitorId && !statusPage.monitors.includes(selection.monitorId)) {
			throw new AppError({ message: "Monitor not found on this status page", status: 404 });
		}
		const selectedIds = selection.monitorId ? [selection.monitorId] : statusPage.monitors;
		const dbSettings = await this.settingsService.getDBSettings();
		const showURL = dbSettings.showURL;
		const monitors = await this.monitorsRepository.findByIds(selectedIds, { recentChecks: range === "latest" ? "all" : "latestHardware" });
		const pageMonitors = monitors.filter((monitor) => monitor.teamId === statusPage.teamId && selectedIds.includes(monitor.id));
		if (selection.monitorId && pageMonitors.length !== 1) {
			throw new AppError({ message: "Monitor not found on this status page", status: 404 });
		}
		const windows = await this.maintenanceWindowsRepository.findByMonitorIds(
			pageMonitors.map(({ id }) => id),
			statusPage.teamId
		);
		const now = new Date();
		const maintenanceWindows = windows
			.filter((window) => window.teamId === statusPage.teamId)
			.map((window) => publicMaintenanceWindow(window, pageMonitors, now))
			.filter((window) => window !== null)
			.sort((a, b) => a.start.localeCompare(b.start));
		const order = new Map(statusPage.monitors.map((id, i) => [id, i]));
		const sorted = [...pageMonitors].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));

		const bucketTimezone = statusPage.timezone ?? "Etc/UTC";
		const history = await this.historyRepository.findHistory(
			statusPage.teamId,
			sorted.map(({ id }) => id),
			range === "latest" ? undefined : STATUS_PAGE_RANGE_DAYS[range],
			bucketTimezone,
			now
		);

		const geoMonitors = sorted.filter((monitor) => monitor.geoCheckEnabled && supportsGeoCheck(monitor.type));
		const geoHistory = geoMonitors.length
			? await this.historyRepository.findGeoHistory(
					statusPage.teamId,
					geoMonitors.map(({ id }) => id),
					range === "latest" ? undefined : STATUS_PAGE_RANGE_DAYS[range],
					bucketTimezone,
					now
				)
			: [];
		const detail = selection.monitorId
			? {
					outages: await this.historyRepository.findIncidentPage(statusPage.teamId, selection.monitorId, selection.incidentPage ?? 0, now),
				}
			: {};
		const toPublic = (monitor: Monitor) => ({
			...this.toPublicMonitor(monitor, showURL, history),
			locations: publicStatusLocations(monitor, geoHistory, range !== "latest", now),
		});

		if (range === "latest") {
			return { statusPage, maintenanceWindows, ...detail, monitors: sorted.map(toPublic) };
		}

		const bucketsByMonitor = history.buckets.reduce((grouped, bucket) => {
			const monitorBuckets = grouped.get(bucket.monitorId);
			if (monitorBuckets) {
				monitorBuckets.push(bucket);
			} else {
				grouped.set(bucket.monitorId, [bucket]);
			}
			return grouped;
		}, new Map<string, DailyCheckBucket[]>());

		return {
			statusPage,
			maintenanceWindows,
			range,
			bucketTimezone,
			checkTTLDays: dbSettings.checkTTL,
			...detail,
			monitors: sorted.map((monitor) => ({
				...toPublic(monitor),
				dailyChecks: bucketsByMonitor.get(monitor.id) ?? [],
			})),
		};
	};

	updateStatusPage = async (id: string, teamId: string, image: Express.Multer.File | undefined, data: Partial<StatusPage>): Promise<StatusPage> => {
		const normalizedData = this.normalizeCustomDomainInput(this.normalizeInput(data));
		const updated = await this.statusPagesRepository.updateById(id, teamId, image, normalizedData);
		return this.normalizeTheme(updated);
	};

	addStatusUpdate = async (id: string, teamId: string, author: string, data: StatusPageUpdateInput): Promise<StatusPage> => {
		const now = new Date().toISOString();
		return this.statusPagesRepository.addUpdate(id, teamId, {
			...data,
			id: randomUUID(),
			author: author.trim().slice(0, 160) || "Staff",
			createdAt: now,
			updatedAt: now,
		});
	};

	editStatusUpdate = async (id: string, teamId: string, updateId: string, data: StatusPageUpdateInput): Promise<StatusPage> =>
		this.statusPagesRepository.editUpdate(id, teamId, updateId, data, new Date().toISOString());

	deleteStatusUpdate = async (id: string, teamId: string, updateId: string): Promise<StatusPage> =>
		this.statusPagesRepository.deleteUpdate(id, teamId, updateId);

	deleteStatusPage = async (statusPageId: string, teamId: string): Promise<StatusPage> => {
		return await this.statusPagesRepository.deleteById(statusPageId, teamId);
	};
}
