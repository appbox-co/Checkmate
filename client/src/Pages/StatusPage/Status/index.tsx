import { useRef } from "react";
import {
	StatusPageSkeleton,
	APPBOX_LOADING_APPEARANCE,
} from "./Components/StatusPageSkeleton";
import { StatusPageUpdatesManager } from "./Components/StatusPageUpdatesManager";
import { BasePage, BaseFallback } from "@/Components/design-elements";
import Typography from "@mui/material/Typography";
import { Link, useSearchParams } from "react-router-dom";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";

import { useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useIsAdmin } from "@/Hooks/useIsAdmin";
import { useLocation, useParams } from "react-router-dom";
import { useGet } from "@/Hooks/UseApi";
import {
	isStatusPageRange,
	resolveStatusPageTheme,
	type StatusPageRange,
} from "@/Types/StatusPage";
import {
	PUBLIC_STATUS_PAGE_PREFIX,
	type StatusPageResponse,
	type StatusPageTheme,
} from "@/Types/StatusPage";
import {
	buildStatusPageApiPath,
	getStatusPagePreviewUrl,
	getStatusPagePublicUrl,
	isCustomDomainHost,
} from "@/Utils/statusPageUrl";
import { cssReferencesExternalResource } from "@/Utils/customCss";
import { HeaderStatusPageControls } from "@/Pages/StatusPage/Status/Components/HeaderStatusPageControls";
import { StatusPageThemeProvider } from "@/Pages/StatusPage/Status/themes/StatusPageThemeProvider";
import {
	BaseStatusPage,
	type ThemeConfig,
} from "@/Pages/StatusPage/Status/themes/shared/BaseStatusPage";
import { BrowserFrame } from "@/Pages/StatusPage/Status/themes/BrowserFrame";
import { refinedStyles } from "@/Pages/StatusPage/Status/themes/refined/styles";
import { RefinedHeader } from "@/Pages/StatusPage/Status/themes/refined/RefinedHeader";
import { RefinedHero } from "@/Pages/StatusPage/Status/themes/refined/RefinedHero";
import { modernStyles } from "@/Pages/StatusPage/Status/themes/modern/styles";
import { ModernHeader } from "@/Pages/StatusPage/Status/themes/modern/ModernHeader";
import { ModernHero } from "@/Pages/StatusPage/Status/themes/modern/ModernHero";
import { boldStyles } from "@/Pages/StatusPage/Status/themes/bold/styles";
import { BoldHeader } from "@/Pages/StatusPage/Status/themes/bold/BoldHeader";
import { BoldHero } from "@/Pages/StatusPage/Status/themes/bold/BoldHero";
import { editorialStyles } from "@/Pages/StatusPage/Status/themes/editorial/styles";
import { EditorialHeader } from "@/Pages/StatusPage/Status/themes/editorial/EditorialHeader";
import { EditorialHero } from "@/Pages/StatusPage/Status/themes/editorial/EditorialHero";
import { minimalStyles } from "@/Pages/StatusPage/Status/themes/minimal/styles";

const THEME_CONFIGS: Record<StatusPageTheme, ThemeConfig<any>> = {
	refined: {
		createStyles: refinedStyles,
		HeaderSlot: RefinedHeader,
		HeroSlot: RefinedHero,
	},
	modern: {
		createStyles: modernStyles,
		HeaderSlot: ModernHeader,
		HeroSlot: ModernHero,
		overallStatusOptions: { iconSize: 20 },
	},
	bold: {
		createStyles: boldStyles,
		HeaderSlot: BoldHeader,
		HeroSlot: BoldHero,
		overallStatusOptions: { iconSize: 18 },
	},
	editorial: {
		createStyles: editorialStyles,
		HeaderSlot: EditorialHeader,
		HeroSlot: EditorialHero,
		overallStatusOptions: { allUpKey: "pages.statusPages.editorial.allUp" },
	},
	minimal: {
		createStyles: minimalStyles,
		HeaderSlot: RefinedHeader,
		HeroSlot: RefinedHero,
	},
};

const StatusPageView = () => {
	const theme = useTheme();
	const { t } = useTranslation();
	const { url, monitorId } = useParams();
	const isAdmin = useIsAdmin();
	const location = useLocation();
	const [searchParams, setSearchParams] = useSearchParams();

	const onRangeChange = (next: StatusPageRange) => {
		const updated = new URLSearchParams(searchParams);
		if (next === "latest") {
			updated.delete("range");
		} else {
			updated.set("range", next);
		}
		setSearchParams(updated, { replace: true });
	};

	const onCustomDomainHost = isCustomDomainHost();
	const isPublic =
		onCustomDomainHost || location.pathname.startsWith(PUBLIC_STATUS_PAGE_PREFIX);

	const rawRange = searchParams.get("range");
	const range = isStatusPageRange(rawRange) ? rawRange : "latest";

	const rawPage = Number(searchParams.get("page") ?? 0);
	const incidentPage =
		Number.isInteger(rawPage) && rawPage >= 0 && rawPage <= 1000 ? rawPage : 0;
	const onIncidentPageChange = (page: number) => {
		const updated = new URLSearchParams(searchParams);
		if (page === 0) updated.delete("page");
		else updated.set("page", String(page));
		setSearchParams(updated);
	};
	const listPath = onCustomDomainHost ? "/" : "/status/public/" + url;
	const apiUrl = buildStatusPageApiPath({
		url,
		useCustomDomain: onCustomDomainHost,
		monitorId,
		incidentPage,
		range,
	});

	const { data, isLoading, error, refetch } = useGet<StatusPageResponse>(
		apiUrl,
		{},
		{
			keepPreviousData: false,
			refreshInterval: range === "latest" ? 10000 : 60000,
		}
	);

	const statusPage = data?.statusPage;
	const monitors = data?.monitors ?? [];
	// Keep only this page's layout while a different range or detail request loads.
	// Health and history always come from the current request.
	const shell = useRef<{ key: string; data: StatusPageResponse; monitorId?: string }>();
	const pageKey = onCustomDomainHost
		? window.location.hostname
		: (isPublic ? "public:" : "private:") + url;
	if (data?.statusPage) shell.current = { key: pageKey, data, monitorId };
	const previous = shell.current?.key === pageKey ? shell.current : undefined;
	const isAppbox =
		url === "appbox" ||
		window.location.hostname.replace(/\.$/, "").toLowerCase() === "status.appbox.co";

	if (!statusPage) {
		const appearance =
			previous?.data.statusPage ?? (isAppbox ? APPBOX_LOADING_APPEARANCE : undefined);
		const customCss = previous?.data.statusPage.customCSS;
		const loadingMonitors = monitorId
			? previous?.data.monitors.filter((monitor) => monitor.id === monitorId)
			: previous?.monitorId
				? undefined
				: previous?.data.monitors;
		return (
			<StatusPageThemeProvider
				theme={appearance?.theme}
				themeMode={appearance?.themeMode}
				timezone={appearance?.timezone}
				brandColor={appearance?.color}
				paintBody={isPublic}
			>
				{customCss && !cssReferencesExternalResource(customCss) && (
					<style>{customCss}</style>
				)}
				<StatusPageSkeleton
					statusPage={previous?.data.statusPage}
					monitors={loadingMonitors}
					appbox={isAppbox}
					config={THEME_CONFIGS[resolveStatusPageTheme(appearance?.theme)]}
					detail={Boolean(monitorId)}
					listPath={listPath}
					range={range}
					onRangeChange={onRangeChange}
					error={Boolean(error)}
					onRetry={() => {
						void refetch();
					}}
				/>
			</StatusPageThemeProvider>
		);
	}

	if (monitors.length === 0 && !statusPage.updates?.length) {
		return (
			<BasePage
				loading={isLoading}
				error={error}
				breadcrumbOverride={isPublic ? [] : undefined}
			>
				<Stack alignItems={"center"}>
					<BaseFallback>
						<Typography
							variant="h1"
							marginY={theme.spacing(4)}
							color={theme.palette.text.secondary}
						>
							{t("pages.statusPages.details.empty.title")}
						</Typography>
						{isAdmin && (
							<Link to={`/status/configure/${url}`}>
								{t("pages.statusPages.details.empty.addMonitor")}
							</Link>
						)}
					</BaseFallback>
				</Stack>
			</BasePage>
		);
	}

	// Public route: render directly on the viewport, themed background covers everything.
	if (isPublic) {
		const themeConfig = THEME_CONFIGS[resolveStatusPageTheme(statusPage.theme)];
		const customCss =
			statusPage.customCSS && !cssReferencesExternalResource(statusPage.customCSS)
				? statusPage.customCSS
				: "";
		return (
			<StatusPageThemeProvider
				theme={statusPage.theme}
				themeMode={statusPage.themeMode}
				timezone={statusPage.timezone}
				brandColor={statusPage.color}
				paintBody
			>
				{customCss && <style>{customCss}</style>}
				<BaseStatusPage
					statusPage={statusPage}
					maintenanceWindows={data.maintenanceWindows ?? []}
					monitors={monitors}
					config={themeConfig}
					range={range}
					onRangeChange={onRangeChange}
					bucketTimezone={data.bucketTimezone ?? statusPage.timezone ?? "Etc/UTC"}
					checkTTLDays={data.checkTTLDays}
					detail={Boolean(monitorId)}
					listPath={listPath}
					outages={data.outages}
					onIncidentPageChange={onIncidentPageChange}
				/>
			</StatusPageThemeProvider>
		);
	}

	const publicUrl = getStatusPagePublicUrl(statusPage);
	const previewUrl = getStatusPagePreviewUrl(statusPage);
	return (
		<BasePage
			loading={isLoading}
			error={error}
			breadcrumbOverride={undefined}
			sx={{ flex: 1, minHeight: 0 }}
		>
			<HeaderStatusPageControls
				isAdmin={isAdmin}
				statusPage={statusPage}
				isPublic={false}
			/>
			{isAdmin && (
				<StatusPageUpdatesManager
					statusPage={statusPage}
					onChange={refetch}
				/>
			)}
			<StatusPageThemeProvider
				theme={statusPage.theme}
				themeMode={statusPage.themeMode}
				timezone={statusPage.timezone}
				transparent
			>
				<BrowserFrame url={publicUrl}>
					<Box
						component="iframe"
						src={previewUrl}
						title={t("pages.statusPages.preview.title")}
						flex={1}
						width="100%"
						border={0}
					/>
				</BrowserFrame>
			</StatusPageThemeProvider>
		</BasePage>
	);
};

export default StatusPageView;
