import Box from "@mui/material/Box";
import type { PublicOutagePage } from "@/Types/StatusPage";
import { useStatusPageTheme } from "../StatusPageThemeProvider";

const duration = (start: string, end: string | null): string => {
	const seconds = Math.max(
		0,
		Math.floor(
			((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 1000
		)
	);
	if (seconds < 60) return seconds + " sec";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + " min";
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return hours + " hr " + (minutes % 60) + " min";
	return Math.floor(hours / 24) + " days " + (hours % 24) + " hr";
};
const httpReasons: Record<number, string> = {
	400: "Bad request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not found",
	408: "Request timeout",
	429: "Too many requests",
	500: "Internal server error",
	502: "Bad gateway",
	503: "Service unavailable",
	504: "Gateway timeout",
};
const reason = (code: number | null): string =>
	code && code >= 100 && code < 600
		? "HTTP " + code + (httpReasons[code] ? " · " + httpReasons[code] : "")
		: "Availability check failed";

export const OutageHistory = ({
	outages,
	timezone,
	onPageChange,
}: {
	outages: PublicOutagePage;
	timezone: string;
	onPageChange: (page: number) => void;
}) => {
	const { tokens } = useStatusPageTheme();
	const formatDate = (date: string) =>
		new Date(date).toLocaleString(undefined, { timeZone: timezone });
	const buttonSx = {
		color: tokens.text,
		background: tokens.surface,
		border: "1px solid " + tokens.border,
		borderRadius: "8px",
		px: "14px",
		py: "8px",
		cursor: "pointer",
		font: "inherit",
		"&:disabled": { opacity: 0.4, cursor: "default" },
	};
	return (
		<Box
			component="section"
			aria-labelledby="outage-history-heading"
			sx={{ mt: "32px" }}
		>
			<Box
				component="h2"
				id="outage-history-heading"
				sx={{ fontSize: 20, mb: "4px" }}
			>
				Outage history
			</Box>
			<Box sx={{ color: tokens.textMuted, fontSize: 12, mb: "16px" }}>
				All recorded confirmed outages · Times in {timezone}
			</Box>
			<Box
				component="ol"
				sx={{
					listStyle: "none",
					m: 0,
					px: { xs: "16px", md: "24px" },
					background: tokens.surface,
					border: "1px solid " + tokens.border,
					borderRadius: "16px",
				}}
			>
				{outages.events.length === 0 && (
					<Box
						component="li"
						sx={{ py: "24px", color: tokens.textMuted }}
					>
						{outages.page === 0
							? "No confirmed outages recorded."
							: "No more outages recorded."}
					</Box>
				)}
				{outages.events.map((event) => (
					<Box
						component="li"
						key={event.id}
						sx={{
							py: "18px",
							borderBottom: "1px solid " + tokens.border,
							"&:last-child": { borderBottom: 0 },
						}}
					>
						<Box
							sx={{
								display: "flex",
								alignItems: "center",
								gap: "10px",
								fontWeight: 600,
								mb: "8px",
							}}
						>
							<Box
								component="span"
								sx={{
									width: 8,
									height: 8,
									flexShrink: 0,
									borderRadius: "50%",
									bgcolor: event.endTime ? tokens.up : tokens.down,
								}}
							/>
							{event.endTime ? "Recovered after " : "Ongoing outage · "}
							{duration(event.startTime, event.endTime)}
						</Box>
						<Box sx={{ fontSize: 12, mb: "8px" }}>{reason(event.statusCode)}</Box>
						<Box sx={{ fontSize: 12, color: tokens.textMuted }}>
							Started{" "}
							<time dateTime={event.startTime}>{formatDate(event.startTime)}</time>
							{event.endTime && (
								<>
									{" "}
									· Recovered{" "}
									<time dateTime={event.endTime}>{formatDate(event.endTime)}</time>
								</>
							)}
						</Box>
					</Box>
				))}
			</Box>
			{(outages.hasMore || outages.page > 0) && (
				<Box
					sx={{
						display: "flex",
						gap: "10px",
						justifyContent: "space-between",
						alignItems: "center",
						mt: "16px",
					}}
				>
					<Box
						component="button"
						type="button"
						sx={buttonSx}
						disabled={outages.page === 0}
						onClick={() => onPageChange(outages.page - 1)}
					>
						Newer outages
					</Box>
					<Box sx={{ fontSize: 12, color: tokens.textMuted }}>
						Page {outages.page + 1}
					</Box>
					<Box
						component="button"
						type="button"
						sx={buttonSx}
						disabled={!outages.hasMore || outages.page >= 1000}
						onClick={() => onPageChange(outages.page + 1)}
					>
						Older outages
					</Box>
				</Box>
			)}
		</Box>
	);
};
