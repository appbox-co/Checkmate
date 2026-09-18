import Box from "@mui/material/Box";
import { useTranslation } from "react-i18next";
import type { PublicStatusLocation, StatusPageRange } from "@/Types/StatusPage";
import { STATUS_PAGE_RANGE_DAYS } from "@/Types/StatusPage";
import { useStatusPageTheme } from "../StatusPageThemeProvider";
import { ThemedHeatmap } from "./ThemedHeatmap";
import { dailyBucketsToCells, type ChartCell } from "./ChartCells";
import type { BaseStyles } from "./BaseStatusPage";

const locationNames: Record<string, string> = {
	EU: "Europe",
	NA: "North America",
	AS: "Asia",
	SA: "South America",
	AF: "Africa",
	OC: "Oceania",
};
const statusNames = {
	up: "Operational",
	down: "Failed",
	unknown: "Awaiting check",
	paused: "Paused",
};

const recentCells = (location: PublicStatusLocation, timezone: string): ChartCell[] => {
	const checks = location.recentChecks.slice(-50);
	const cells = checks.map((check, i): ChartCell => {
		const label = [
			new Date(check.createdAt).toLocaleString(undefined, { timeZone: timezone }),
			timezone,
			check.city,
			check.country,
			check.status ? "Passed" : "Failed",
			check.responseTime == null ? "" : Math.round(check.responseTime) + " ms",
		]
			.filter(Boolean)
			.join(" · ");
		return {
			key: check.createdAt + "-" + i,
			severity: check.status ? 0 : 1,
			barKind: check.status ? "up" : "down",
			heatKind: check.status ? "fast" : "down",
			heightPct: 100,
			responseTime: check.responseTime ?? 0,
			tooltip: label,
			ariaLabel: label,
		};
	});
	return [
		...Array.from(
			{ length: 50 - cells.length },
			(_, i): ChartCell => ({
				key: "empty-" + i,
				severity: 0,
				barKind: "empty",
				heatKind: "empty",
				heightPct: 0,
				responseTime: 0,
				tooltip: null,
				ariaLabel: "No observation",
			})
		),
		...cells,
	];
};

export const StatusLocations = ({
	locations,
	range,
	timezone,
	styles,
	showCharts,
}: {
	locations: PublicStatusLocation[];
	range: StatusPageRange;
	timezone: string;
	styles: BaseStyles;
	showCharts: boolean;
}) => {
	const { tokens } = useStatusPageTheme();
	const { t } = useTranslation();
	return (
		<Box
			sx={{
				px: { xs: "12px", md: "24px" },
				pb: "20px",
				pt: "14px",
				borderTop: "1px solid " + tokens.border,
			}}
		>
			<Box sx={{ color: tokens.textMuted, fontSize: 11, mb: "14px" }}>
				Geographic probes · {range === "latest" ? "latest 50 results" : "daily results"} ·
				grey means no data
			</Box>
			{locations.map((location) => {
				const label = locationNames[location.continent] ?? location.continent;
				const color =
					location.status === "up"
						? tokens.up
						: location.status === "down"
							? tokens.down
							: tokens.textMuted;
				const cells =
					range === "latest"
						? recentCells(location, timezone)
						: dailyBucketsToCells(
								location.dailyChecks ?? [],
								STATUS_PAGE_RANGE_DAYS[range],
								timezone,
								t
							).map((cell) => ({
								...cell,
								heatKind: cell.barKind === "up" ? ("fast" as const) : cell.heatKind,
							}));
				return (
					<Box
						component="section"
						aria-label={label + " probe results"}
						key={location.continent}
						sx={{ mb: "14px", "&:last-child": { mb: 0 } }}
					>
						<Box
							sx={{
								display: "flex",
								justifyContent: "space-between",
								gap: "8px",
								flexWrap: "wrap",
								mb: "5px",
								fontSize: 12,
							}}
						>
							<Box sx={{ fontWeight: 600 }}>{label}</Box>
							<Box sx={{ color, display: "flex", alignItems: "center", gap: "6px" }}>
								<Box
									component="span"
									sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: color }}
								/>
								{location.status === "unknown" && location.stale && location.checkedAt
									? "Stale"
									: statusNames[location.status]}
								{location.status === "down" && location.stale ? " · stale" : ""}
							</Box>
						</Box>
						{showCharts && (
							<ThemedHeatmap
								cells={cells}
								containerSx={{
									display: "grid",
									gap: { xs: "1px", md: "3px" },
									height: 14,
								}}
								cellSx={styles.heatmapCell}
							/>
						)}
						<Box
							sx={{
								color: tokens.textMuted,
								fontSize: 11,
								mt: "5px",
								overflowWrap: "anywhere",
							}}
						>
							Every {Math.round(location.interval / 60000)} min
							{location.checkedAt
								? " · Last result " +
									new Date(location.checkedAt).toLocaleString(undefined, {
										timeZone: timezone,
									}) +
									" " +
									timezone
								: " · No results yet"}
							{location.city
								? " · " + [location.city, location.country].filter(Boolean).join(", ")
								: ""}
						</Box>
					</Box>
				);
			})}
		</Box>
	);
};
