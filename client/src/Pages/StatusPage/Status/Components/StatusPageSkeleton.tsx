import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Skeleton from "@mui/material/Skeleton";
import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { visuallyHidden } from "@mui/utils";
import type { SxProps, Theme } from "@mui/material/styles";
import type { StatusPage, StatusPageMonitor, StatusPageRange } from "@/Types/StatusPage";
import { STATUS_PAGE_RANGES, STATUS_PAGE_RANGE_DAYS } from "@/Types/StatusPage";
import type { ThemeConfig } from "../themes/shared/BaseStatusPage";
import { useStatusPageTheme } from "../themes/StatusPageThemeProvider";
import appboxLogo from "@/assets/Images/appbox-status-logo.png";

export const APPBOX_LOADING_APPEARANCE = {
	theme: "modern",
	themeMode: "dark",
	color: "#13715B",
	timezone: "Europe/London",
} as const;

interface Props {
	statusPage?: StatusPage;
	monitors?: StatusPageMonitor[];
	appbox: boolean;
	config: ThemeConfig<any>;
	detail: boolean;
	listPath: string;
	range: StatusPageRange;
	onRangeChange: (range: StatusPageRange) => void;
	error: boolean;
	onRetry: () => void;
}

const locationNames: Record<string, string> = {
	EU: "Europe",
	NA: "North America",
	AS: "Asia",
	SA: "South America",
	AF: "Africa",
	OC: "Oceania",
};

export const StatusPageSkeleton = ({
	statusPage,
	monitors,
	appbox,
	config,
	detail,
	listPath,
	range,
	onRangeChange,
	error,
	onRetry,
}: Props) => {
	const { t } = useTranslation();
	const { tokens, mode } = useStatusPageTheme();
	const styles = useMemo(
		() => config.createStyles(tokens, mode === "dark"),
		[config, tokens, mode]
	);
	const logoSrc = statusPage?.logo?.data
		? "data:" + statusPage.logo.contentType + ";base64," + statusPage.logo.data
		: appbox
			? appboxLogo
			: null;
	const brand = statusPage ?? {
		url: appbox ? "appbox" : "",
		companyName: appbox ? "Appbox" : "",
	};
	const { HeaderSlot } = config;
	const showCharts = statusPage?.showCharts !== false;
	const cards = monitors?.length
		? monitors
		: Array.from({ length: detail ? 1 : 6 }, () => undefined);
	const cellCount = range === "latest" ? 50 : STATUS_PAGE_RANGE_DAYS[range];
	const placeholder = (width: number | string, height: number, sx?: SxProps<Theme>) => (
		<Skeleton
			variant="rounded"
			animation={error ? false : "wave"}
			width={width}
			height={height}
			sx={[
				{ bgcolor: tokens.border, maxWidth: "100%", flexShrink: 0 },
				...(Array.isArray(sx) ? sx : [sx ?? {}]),
			]}
		/>
	);
	// One shimmer per row keeps long histories lightweight even with many monitors.
	const chart = (height: number) =>
		placeholder("100%", height, {
			borderRadius: "3px",
			"--cell-size": 100 / cellCount + "%",
			"--cell-gap": { xs: "1px", md: "3px" },
			maskImage:
				"repeating-linear-gradient(to right, #000 0, #000 calc(var(--cell-size) - var(--cell-gap)), transparent calc(var(--cell-size) - var(--cell-gap)), transparent var(--cell-size))",
		});
	const quietCard = [
		styles.card,
		{
			opacity: 1,
			transform: "none",
			animation: "none",
			"&:hover": { transform: "none" },
		},
	];

	return (
		<Box
			sx={[
				styles.page,
				{
					"@media (prefers-reduced-motion: reduce)": {
						"& .MuiSkeleton-root, & .MuiSkeleton-root::after": { animation: "none" },
					},
				},
			]}
		>
			<Stack
				component="header"
				direction={{ xs: "column", md: "row" }}
				sx={styles.top}
			>
				{brand.companyName ? (
					<HeaderSlot
						statusPage={brand}
						logoSrc={logoSrc}
						overall={{ tone: "warn", message: "", icon: null }}
						monitorCount={0}
						styles={styles}
					/>
				) : (
					<Box aria-hidden="true">{placeholder(120, 32)}</Box>
				)}
			</Stack>
			{!error && (
				<Box
					role="status"
					sx={visuallyHidden}
				>
					Loading service status…
				</Box>
			)}
			<Box
				component="main"
				aria-label="Service status"
				aria-busy={!error}
			>
				{detail && (
					<Box sx={{ mb: 3 }}>
						<Box
							component={Link}
							to={listPath}
							sx={{ color: tokens.textMuted, fontSize: 13, textUnderlineOffset: "3px" }}
						>
							← Back to all services
						</Box>
						<Box
							aria-hidden="true"
							sx={{ mt: 2, mb: 0.5 }}
						>
							{placeholder("58%", 45)}
						</Box>
						<Box sx={{ color: tokens.textMuted, fontSize: 13 }}>
							Availability and outage history
						</Box>
					</Box>
				)}
				{error ? (
					<Box
						role="alert"
						sx={styles.hero ?? styles.card}
					>
						<Box
							component="h1"
							sx={{ m: 0, fontSize: 22 }}
						>
							Status unavailable
						</Box>
						<Box
							component="p"
							sx={{ color: tokens.textMuted }}
						>
							This status page or monitor could not be loaded.
						</Box>
						<Box
							component="button"
							type="button"
							onClick={onRetry}
							sx={[
								styles.chartSwitchButton(false),
								{
									alignSelf: "flex-start",
									border: "1px solid " + tokens.border,
									px: 2,
									py: 1,
								},
							]}
						>
							Try again
						</Box>
					</Box>
				) : (
					!detail && (
						<Box
							aria-hidden="true"
							sx={styles.hero ?? styles.card}
						>
							<Box
								sx={{
									display: "flex",
									alignItems: "center",
									gap: { xs: "14px", md: "20px" },
								}}
							>
								{placeholder(14, 14, { borderRadius: "50%" })}
								{placeholder("56%", 33)}
							</Box>
							{placeholder("42%", 19.5)}
						</Box>
					)
				)}
				{showCharts && (
					<Stack>
						<Box sx={styles.chartSwitchWrap}>
							<Box
								sx={styles.chartSwitch}
								aria-hidden="true"
							>
								{[
									t("pages.statusPages.monitorsList.chartTypeHeatmap"),
									t("pages.statusPages.monitorsList.chartTypeHistogram"),
								].map((label) => (
									<Box
										key={label}
										component="button"
										type="button"
										disabled
										tabIndex={-1}
										sx={[styles.chartSwitchButton(false), { cursor: "default" }]}
									>
										{label}
									</Box>
								))}
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
										key={value}
										role="radio"
										aria-checked={range === value}
										onClick={() => onRangeChange(value)}
										sx={styles.chartSwitchButton(range === value)}
									>
										{t("pages.statusPages.range." + value)}
									</Box>
								))}
							</Box>
						</Box>
					</Stack>
				)}
				<Stack
					component="ul"
					aria-hidden="true"
					sx={styles.monitorList}
				>
					{cards.map((monitor, i) => {
						const locations =
							monitor?.locations?.map((location) => location.continent) ??
							(appbox ? ["EU", "NA", "AS"] : []);
						return (
							<Box
								component="li"
								key={monitor?.id ?? i}
								sx={quietCard}
							>
								<Box sx={styles.cardRow}>
									<Box sx={styles.monitorName}>
										{placeholder(i % 2 ? "44%" : "56%", 23)}
									</Box>
									<Box sx={{ gridArea: "status" }}>
										{placeholder(104, 27, { borderRadius: "999px" })}
									</Box>
									<Stack
										direction="row"
										sx={styles.monitorMeta}
									>
										{placeholder(52, 21)}
										{placeholder(65, 21)}
									</Stack>
								</Box>
								{showCharts && (
									<Box sx={{ px: { xs: "12px", md: "24px" }, pb: "20px" }}>
										{locations.length > 0 && (
											<Box sx={{ mb: "8px" }}>{placeholder(170, 16.5)}</Box>
										)}
										{chart(26)}
									</Box>
								)}
								{locations.length > 0 && (
									<Box
										sx={{
											px: { xs: "12px", md: "24px" },
											pt: "14px",
											pb: "20px",
											borderTop: "1px solid " + tokens.border,
										}}
									>
										<Box sx={{ mb: "14px" }}>{placeholder("48%", 16.5)}</Box>
										{locations.map((continent) => (
											<Box
												key={continent}
												sx={{ mb: "14px", "&:last-child": { mb: 0 } }}
											>
												<Box
													sx={{
														display: "flex",
														alignItems: "center",
														justifyContent: "space-between",
														mb: "5px",
														gap: "8px",
													}}
												>
													<Box sx={{ fontWeight: 600, fontSize: 12 }}>
														{locationNames[continent] ?? continent}
													</Box>
													{placeholder(86, 18)}
												</Box>
												{showCharts && chart(14)}
												<Box sx={{ mt: "5px" }}>{placeholder("68%", 16.5)}</Box>
											</Box>
										))}
									</Box>
								)}
							</Box>
						);
					})}
				</Stack>
				{detail && (
					<Box
						component="section"
						aria-label="Outage history"
						sx={{ mt: "32px" }}
					>
						<Box
							component="h2"
							sx={{ fontSize: 20, mb: "16px" }}
						>
							Outage history
						</Box>
						<Box
							aria-hidden="true"
							sx={[...quietCard, { px: "24px" }]}
						>
							{[0, 1, 2].map((i) => (
								<Box
									key={i}
									sx={{
										py: "20px",
										borderBottom: i < 2 ? "1px solid " + tokens.border : 0,
									}}
								>
									{placeholder("38%", 21)}
									<Box sx={{ mt: "10px" }}>{placeholder("62%", 18)}</Box>
								</Box>
							))}
						</Box>
					</Box>
				)}
			</Box>
			<Box
				component="footer"
				sx={styles.footer}
			>
				<a href="/source/checkmate-appbox-source.tar.gz">
					{t("pages.statusPages.footer.sourceCode")}
				</a>
			</Box>
		</Box>
	);
};
