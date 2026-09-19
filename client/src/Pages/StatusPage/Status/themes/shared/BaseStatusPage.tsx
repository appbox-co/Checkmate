import { StatusPageCommunications } from "../../Components/StatusPageCommunications";
import type { PublicMaintenanceWindow } from "@/Types/StatusPage";
import { Link } from "react-router-dom";
import { StatusLocations } from "./StatusLocations";
import { OutageHistory } from "./OutageHistory";
import type { PublicOutagePage, StatusPageMonitor } from "@/Types/StatusPage";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { TriangleAlert } from "lucide-react";

import type { SxProps, Theme } from "@mui/material/styles";
import type { StatusPage, StatusPageRange } from "@/Types/StatusPage";
import {
	getMonitorTypeLabel,
	STATUS_PAGE_RANGE_DAYS,
	STATUS_PAGE_RANGES,
} from "@/Types/StatusPage";
import type { StatusPageThemeTokens } from "@/Pages/StatusPage/Status/themes/tokens";
import { ThemedHeatmap } from "@/Pages/StatusPage/Status/themes/shared/ThemedHeatmap";
import { ThemedHistogram } from "@/Pages/StatusPage/Status/themes/shared/ThemedHistogram";
import {
	ThemedInfrastructure,
	type GaugeFillLevel,
} from "@/Pages/StatusPage/Status/themes/shared/ThemedInfrastructure";
import {
	type OverallStatus,
	type OverallTone,
	monitorBadgeTone,
	resolveOverallStatus,
	statusBadgeKey,
} from "@/Pages/StatusPage/Status/themes/shared/overallStatus";
import { formatPercentage } from "@/Utils/FormatUtils";
import {
	checksToCells,
	dailyBucketsToCells,
	type BarKind,
	type HeatCellKind,
} from "@/Pages/StatusPage/Status/themes/shared/ChartCells";
import { LAYOUT } from "@/Utils/Theme/constants";
import { Icon } from "@/Components/design-elements";

import { useStatusPageTheme } from "@/Pages/StatusPage/Status/themes/StatusPageThemeProvider";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "@mui/material";

export interface BaseStyles {
	page: SxProps<Theme>;
	top: SxProps<Theme>;
	chartSwitchWrap: SxProps<Theme>;
	chartSwitch: SxProps<Theme>;
	chartSwitchButton: (active: boolean) => SxProps<Theme>;
	monitorList: SxProps<Theme>;
	card: SxProps<Theme>;
	cardRow: SxProps<Theme>;
	cardLeft: SxProps<Theme>;
	monitorName: SxProps<Theme>;
	monitorMeta: SxProps<Theme>;
	pill: SxProps<Theme>;
	pillHardware: SxProps<Theme>;
	monitorUrl: SxProps<Theme>;
	badge: (tone: OverallTone) => SxProps<Theme>;
	heatmap: SxProps<Theme>;
	heatmapCell: (kind: HeatCellKind, severity?: number) => SxProps<Theme>;
	histogram: SxProps<Theme>;
	bar: (kind: BarKind, heightPct: number, severity?: number) => SxProps<Theme>;
	chartStats: SxProps<Theme>;
	infra: SxProps<Theme>;
	infraEmpty: SxProps<Theme>;
	gauge: SxProps<Theme>;
	gaugeLabel: SxProps<Theme>;
	gaugeValue: SxProps<Theme>;
	gaugeBar: SxProps<Theme>;
	gaugeFill: (level: GaugeFillLevel, widthPct: number) => SxProps<Theme>;
	gaugeSub: SxProps<Theme>;
	footer: SxProps<Theme>;
}

export interface SlotProps<S extends BaseStyles = BaseStyles> {
	statusPage: Pick<StatusPage, "companyName" | "url">;
	logoSrc: string | null;
	overall: OverallStatus;
	monitorCount: number;
	styles: S;
}

export interface ThemeConfig<S extends BaseStyles = BaseStyles> {
	createStyles: (tokens: StatusPageThemeTokens, isDark: boolean) => S;
	HeaderSlot: React.ComponentType<SlotProps<S>>;
	HeroSlot: React.ComponentType<SlotProps<S>>;
	overallStatusOptions?: { iconSize?: number; allUpKey?: string };
}

interface Props {
	detail?: boolean;
	listPath: string;
	outages?: PublicOutagePage;
	onIncidentPageChange: (page: number) => void;
	maintenanceWindows?: PublicMaintenanceWindow[];
	statusPage: StatusPage;
	monitors: StatusPageMonitor[];
	config: ThemeConfig<any>;
	range: StatusPageRange;
	onRangeChange: (range: StatusPageRange) => void;
	bucketTimezone: string;
	checkTTLDays?: number;
}

export const BaseStatusPage = ({
	maintenanceWindows = [],
	statusPage,
	monitors,
	config,
	range,
	onRangeChange,
	bucketTimezone,
	checkTTLDays,
	detail = false,
	listPath,
	outages,
	onIncidentPageChange,
}: Props) => {
	const theme = useTheme();
	const { t } = useTranslation();
	const { tokens, mode } = useStatusPageTheme();
	const styles = useMemo(
		() => config.createStyles(tokens, mode === "dark"),
		[config, tokens, mode]
	);
	const [chartMode, setChartMode] = useState<"heatmap" | "histogram">("heatmap");

	const activeMonitors = monitors.filter((monitor) => monitor.status !== "paused");
	const overall = resolveOverallStatus(activeMonitors, t, config.overallStatusOptions);
	const logoSrc = statusPage.logo?.data
		? `data:${statusPage.logo.contentType};base64,${statusPage.logo.data}`
		: null;

	const { HeaderSlot, HeroSlot } = config;

	return (
		<Box sx={styles.page}>
			{statusPage.customCSS && <style>{statusPage.customCSS}</style>}
			<Stack
				component="header"
				direction={{ xs: "column", md: "row" }}
				sx={styles.top}
			>
				<HeaderSlot
					statusPage={statusPage}
					logoSrc={logoSrc}
					overall={overall}
					monitorCount={activeMonitors.length}
					styles={styles}
				/>
			</Stack>

			{detail ? (
				<Box sx={{ mb: 3 }}>
					<Box
						component={Link}
						to={listPath}
						sx={{ color: tokens.textMuted, fontSize: 13, textUnderlineOffset: "3px" }}
					>
						← Back to all services
					</Box>
					<Box
						component="h1"
						sx={{
							mt: 2,
							mb: 0.5,
							fontSize: { xs: 22, md: 30 },
							overflowWrap: "anywhere",
						}}
					>
						{monitors[0]?.name}
					</Box>
					<Box sx={{ color: tokens.textMuted, fontSize: 13 }}>
						Availability and outage history
						{monitors[0]?.interval
							? " · Checked every " + Math.round(monitors[0].interval / 1000) + " seconds"
							: ""}
					</Box>
				</Box>
			) : (
				<HeroSlot
					statusPage={statusPage}
					logoSrc={logoSrc}
					overall={overall}
					monitorCount={activeMonitors.length}
					styles={styles}
				/>
			)}

			<StatusPageCommunications
				section="notices"
				updates={statusPage.updates ?? []}
				maintenanceWindows={maintenanceWindows}
				timezone={statusPage.timezone}
			/>

			{statusPage.showCharts && (
				<Stack>
					<Box sx={styles.chartSwitchWrap}>
						<Box
							sx={styles.chartSwitch}
							role="radiogroup"
						>
							<Box
								component="button"
								type="button"
								role="radio"
								aria-checked={chartMode === "heatmap"}
								onClick={() => setChartMode("heatmap")}
								sx={styles.chartSwitchButton(chartMode === "heatmap")}
							>
								{t("pages.statusPages.monitorsList.chartTypeHeatmap")}
							</Box>
							<Box
								component="button"
								type="button"
								role="radio"
								aria-checked={chartMode === "histogram"}
								onClick={() => setChartMode("histogram")}
								sx={styles.chartSwitchButton(chartMode === "histogram")}
							>
								{t("pages.statusPages.monitorsList.chartTypeHistogram")}
							</Box>
						</Box>
					</Box>
					<Box sx={styles.chartSwitchWrap}>
						<Box
							sx={styles.chartSwitch}
							role="radiogroup"
							aria-label={t("pages.statusPages.rangeSelectorAria")}
						>
							{STATUS_PAGE_RANGES.map((value) => (
								<Box
									component="button"
									type="button"
									role="radio"
									key={value}
									aria-checked={range === value}
									onClick={() => onRangeChange(value)}
									sx={styles.chartSwitchButton(range === value)}
								>
									{t(`pages.statusPages.range.${value}`)}
								</Box>
							))}
						</Box>
					</Box>
					{range !== "latest" &&
						checkTTLDays &&
						STATUS_PAGE_RANGE_DAYS[range] > checkTTLDays && (
							<Stack
								mb={LAYOUT.XS}
								alignSelf="flex-end"
								direction="row"
								alignItems="center"
								gap={LAYOUT.XXS}
							>
								<Icon
									icon={TriangleAlert}
									size={20}
									color={theme.palette.warning.main}
								/>
								<Typography>
									{t("pages.statusPages.rangeExceedsRetention", { days: checkTTLDays })}
								</Typography>
							</Stack>
						)}
				</Stack>
			)}

			<Stack
				component="ul"
				sx={styles.monitorList}
			>
				{monitors.map((monitor) => {
					const isHardware = monitor.type === "hardware";
					const showInfra = isHardware && statusPage.showInfrastructure !== false;
					const showChart = !isHardware && statusPage.showCharts !== false;
					const badgeTone = monitorBadgeTone(monitor.status);
					const uptimePercentage =
						monitor.uptimePercentage == null
							? "—"
							: formatPercentage(monitor.uptimePercentage);

					const cells =
						range === "latest"
							? checksToCells(monitor.recentChecks ?? [])
							: dailyBucketsToCells(
									monitor.dailyChecks ?? [],
									STATUS_PAGE_RANGE_DAYS[range],
									bucketTimezone,
									t
								);

					return (
						<Box
							component="li"
							key={monitor.id}
							sx={styles.card}
						>
							<Box sx={styles.cardRow}>
								{detail ? (
									<Box sx={styles.monitorName}>{monitor.name}</Box>
								) : (
									<Box
										component={Link}
										to={
											(listPath === "/" ? "" : listPath) +
											"/monitors/" +
											monitor.id +
											(range === "latest" ? "" : "?range=" + range)
										}
										sx={[
											styles.monitorName,
											{
												textDecoration: "none",
												"&:hover": { textDecoration: "underline" },
												"&:focus-visible": {
													outline: "2px solid " + tokens.up,
													outlineOffset: 3,
												},
											},
										]}
										title={"View outage history for " + monitor.name}
									>
										{monitor.name}{" "}
										<Box
											component="span"
											aria-hidden="true"
											sx={{ color: tokens.textMuted, fontSize: 12 }}
										>
											↗
										</Box>
									</Box>
								)}
								<Box
									component="span"
									sx={styles.badge(badgeTone)}
								>
									{t(statusBadgeKey[monitor.status])}
								</Box>
								<Stack
									direction={{ xs: "column", md: "row" }}
									sx={styles.monitorMeta}
								>
									<Box
										component="span"
										sx={isHardware ? styles.pillHardware : styles.pill}
									>
										{getMonitorTypeLabel(monitor.type, t)}
									</Box>
									<Box
										component="span"
										sx={{ ...styles.pill }}
									>
										{uptimePercentage}
									</Box>
									{monitor.url && (
										<Box
											component="span"
											sx={styles.monitorUrl}
											title={monitor.url}
										>
											{monitor.url}
										</Box>
									)}
								</Stack>
							</Box>

							{showInfra && (
								<ThemedInfrastructure
									monitor={monitor}
									sxApi={{
										containerSx: styles.infra,
										emptySx: styles.infraEmpty,
										gaugeSx: styles.gauge,
										gaugeLabelSx: styles.gaugeLabel,
										gaugeValueSx: styles.gaugeValue,
										gaugeBarSx: styles.gaugeBar,
										gaugeFillSx: styles.gaugeFill,
										gaugeSubSx: styles.gaugeSub,
									}}
								/>
							)}
							{showChart && Boolean(monitor.locations?.length) && (
								<Box
									sx={{ px: "24px", pb: "8px", color: tokens.textMuted, fontSize: 11 }}
								>
									Overall · confirmed availability
								</Box>
							)}
							{showChart &&
								(chartMode === "heatmap" ? (
									<ThemedHeatmap
										cells={cells}
										containerSx={styles.heatmap}
										cellSx={styles.heatmapCell}
									/>
								) : (
									<ThemedHistogram
										cells={cells}
										containerSx={styles.histogram}
										barSx={styles.bar}
										statsSx={styles.chartStats}
									/>
								))}
							{Boolean(monitor.locations?.length) && (
								<StatusLocations
									locations={monitor.locations!}
									range={range}
									timezone={bucketTimezone}
									styles={styles}
									showCharts={showChart}
								/>
							)}
						</Box>
					);
				})}
			</Stack>

			{detail && outages && (
				<OutageHistory
					outages={outages}
					timezone={bucketTimezone}
					onPageChange={onIncidentPageChange}
				/>
			)}

			<StatusPageCommunications
				section="updates"
				updates={statusPage.updates ?? []}
				maintenanceWindows={[]}
				timezone={statusPage.timezone}
			/>
			<Box
				component="footer"
				sx={styles.footer}
			>
				<a
					href="https://github.com/appboxco/Checkmate"
					target="_blank"
					rel="noopener noreferrer"
				>
					{t("pages.statusPages.footer.sourceCode")}
				</a>
			</Box>
		</Box>
	);
};
