import { useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import { Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PublicMaintenanceWindow, StatusPageUpdate } from "@/Types/StatusPage";
import { formatStatusDate, sortStatusUpdates } from "@/Utils/statusPageUpdates";
import { useStatusPageTheme } from "../themes/StatusPageThemeProvider";

interface Props {
	section: "notices" | "updates";
	updates: StatusPageUpdate[];
	maintenanceWindows: PublicMaintenanceWindow[];
	timezone?: string;
}

export const StatusPageCommunications = ({
	section,
	updates,
	maintenanceWindows,
	timezone = "Etc/UTC",
}: Props) => {
	const { t, i18n } = useTranslation();
	const { tokens } = useStatusPageTheme();
	const [visibleCount, setVisibleCount] = useState(5);
	const sorted = sortStatusUpdates(updates);
	const pinned = sorted.filter((update) => update.pinned);
	const recent = sorted.filter((update) => !update.pinned);
	const date = (value: string) => formatStatusDate(value, timezone, i18n.language);
	const card = {
		p: { xs: "16px", sm: "20px" },
		bgcolor: tokens.surface,
		border: `1px solid ${tokens.border}`,
		borderRadius: tokens.radius,
		overflowWrap: "anywhere" as const,
	};
	const heading = {
		m: 0,

		fontWeight: 600,
		fontFamily: tokens.headingFontFamily ?? "inherit",
	};

	const renderUpdate = (update: StatusPageUpdate) => (
		<Box
			component="article"
			key={update.id}
			sx={card}
		>
			<Stack
				direction="row"
				gap="8px"
				alignItems="center"
				flexWrap="wrap"
				mb="6px"
			>
				{update.pinned && (
					<Box
						component="span"
						display={"inline-flex"}
						gap={"4px"}
						fontSize={12}
						sx={{ alignItems: "center" }}
					>
						<Pin
							size={14}
							aria-hidden="true"
						/>
						{t("pages.statusPages.communications.pinned")}
					</Box>
				)}
				<Box
					component="span"
					fontSize={12}
					fontWeight={600}
					color={update.status === "resolved" ? tokens.upStrong : tokens.textMuted}
				>
					{t(`pages.statusPages.communications.status.${update.status}`)}
				</Box>
			</Stack>
			<Box
				component="h3"
				fontSize={16}
				sx={{ ...heading }}
			>
				{update.title}
			</Box>
			<Box
				component="p"
				my={"10px"}
				lineHeight={1.65}
				sx={{ whiteSpace: "pre-wrap" }}
			>
				{update.body}
			</Box>
			<Box
				fontSize={12}
				color={tokens.textMuted}
			>
				{t("pages.statusPages.communications.by", { author: update.author })}
				{" · "}
				<time dateTime={update.createdAt}>{date(update.createdAt)}</time>
				{update.updatedAt !== update.createdAt && (
					<Box component="span">
						{" · "}
						{t("pages.statusPages.communications.edited", {
							date: date(update.updatedAt),
						})}
					</Box>
				)}
			</Box>
		</Box>
	);

	if (
		section === "notices" ? !pinned.length && !maintenanceWindows.length : !recent.length
	)
		return null;
	return (
		<Stack
			gap="24px"
			my={"24px"}
			color={tokens.text}
		>
			{section === "notices" && pinned.length > 0 && (
				<Stack
					component="section"
					aria-label={t("pages.statusPages.communications.pinnedAnnouncements")}
					gap="12px"
				>
					<Box
						component="h2"
						fontSize={18}
						sx={heading}
					>
						{t("pages.statusPages.communications.pinnedAnnouncements")}
					</Box>
					{pinned.map(renderUpdate)}
				</Stack>
			)}
			{section === "notices" && maintenanceWindows.length > 0 && (
				<Stack
					component="section"
					aria-label={t("pages.statusPages.communications.maintenance")}
					gap="12px"
				>
					<Box
						component="h2"
						fontSize={18}
						sx={heading}
					>
						{t("pages.statusPages.communications.maintenance")}
					</Box>
					<Box
						fontSize={12}
						color={tokens.textMuted}
					>
						{t("pages.statusPages.communications.timezone", { timezone })}
					</Box>
					{maintenanceWindows.map((window) => (
						<Box
							component="article"
							key={window.id}
							sx={card}
						>
							<Box
								fontSize={12}
								fontWeight={600}
								color={
									window.status === "in_progress" ? tokens.degraded : tokens.textMuted
								}
								mb={"6px"}
							>
								{t(`pages.statusPages.communications.${window.status}`)}
							</Box>
							<Box
								component="h3"
								fontSize={16}
								sx={{ ...heading }}
							>
								{window.name}
							</Box>
							<Box
								component="p"
								my={"10px"}
							>
								<time dateTime={window.start}>{date(window.start)}</time>
								{" – "}
								<time dateTime={window.end}>{date(window.end)}</time>
							</Box>
							<Box color={tokens.textMuted}>
								{t("pages.statusPages.communications.affected", {
									services: window.monitors.map(({ name }) => name).join(", "),
								})}
							</Box>
							{window.repeat > 0 && (
								<Box
									fontSize={12}
									color={tokens.textMuted}
									mt={"6px"}
								>
									{window.repeat === 86400000
										? t("pages.statusPages.communications.daily")
										: window.repeat === 604800000
											? t("pages.statusPages.communications.weekly")
											: t("pages.statusPages.communications.recurring")}
								</Box>
							)}
						</Box>
					))}
				</Stack>
			)}
			{section === "updates" && recent.length > 0 && (
				<Stack
					component="section"
					aria-label={t("pages.statusPages.communications.staffUpdates")}
					gap="12px"
				>
					<Box
						component="h2"
						fontSize={18}
						sx={heading}
					>
						{t("pages.statusPages.communications.staffUpdates")}
					</Box>
					{recent.slice(0, visibleCount).map(renderUpdate)}
					{recent.length > visibleCount && (
						<Box
							component="button"
							type="button"
							onClick={() => setVisibleCount((count) => count + 10)}
							color={tokens.text}
							bgcolor={tokens.surface}
							border={`1px solid ${tokens.border}`}
							borderRadius={tokens.radius}
							px={"16px"}
							py={"10px"}
							sx={{ alignSelf: "flex-start", cursor: "pointer", font: "inherit" }}
						>
							{t("pages.statusPages.communications.more")}
						</Box>
					)}
				</Stack>
			)}
		</Stack>
	);
};
